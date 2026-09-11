import { afterEach, describe, expect, it, vi } from "vitest";
import { ParmanaExecutionAmbiguousError, ParmanaHttpClient, type BusinessTransaction } from "../../src/parmana/client.js";

/**
 * Regression coverage for a real bug found and fixed this session:
 * the client originally expected a {transaction, context, trustRecord}
 * response envelope from POST /execute that no real Parmana deployment
 * has ever returned, and treated a clean policy denial (HTTP 403,
 * {error, code: "POLICY_DENIED"}) as a generic thrown error instead of
 * a normal DENIED result. Fixture shapes below are trimmed, faithful
 * copies of the actual response bodies captured against the live
 * deployment (https://parmana-api-real.vercel.app) -- not invented.
 */

function transaction(businessTransactionId: string): BusinessTransaction {
  return {
    businessTransactionId,
    metadata: {},
    authority: {},
    authorization: {},
    intent: { action: "paytm-refund", target: "order-1", parameters: {} },
    policy: { name: "customer-refund", version: "1.0.0", schemaVersion: "1.0.0" },
    signals: {},
    status: "RECEIVED",
    createdAt: new Date().toISOString(),
  };
}

function client(): ParmanaHttpClient {
  return new ParmanaHttpClient({ baseUrl: "https://parmana.example.com", apiKey: "test-key", timeoutMs: 2000 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ParmanaHttpClient.execute", () => {
  it("parses a real APPROVED trust-record response, not the old invented {transaction, context, trustRecord} envelope", async () => {
    const businessTransactionId = "31ac3c17-d0ea-458c-9cc3-e843e1722f9a";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          trustRecordId: "118e30c0-321e-4d12-8f10-2d9f1f39aed1",
          businessTransactionId,
          transaction: { businessTransactionId, intent: { action: "paytm-refund" } },
          executions: [
            {
              decision: { outcome: "APPROVED", reason: "Refund authorized." },
              metadata: { authorizationId: "305631e6-3706-4368-844f-e8a3af1f273b" },
            },
          ],
          authorization: { payload: { authorizationId: "305631e6-3706-4368-844f-e8a3af1f273b" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client().execute(transaction(businessTransactionId));

    expect(result.outcome).toBe("APPROVED");
    if (result.outcome !== "APPROVED") throw new Error("unreachable");
    expect(result.authorizationId).toBe("305631e6-3706-4368-844f-e8a3af1f273b");
    expect(result.businessTransactionId).toBe(businessTransactionId);
  });

  it("parses a real DENIED response (HTTP 403, POLICY_DENIED) as a clean result, never a thrown error", async () => {
    const businessTransactionId = "denied-txn-1";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Execution rejected: Refund rejected because the requested refund amount exceeds the maximum permitted threshold.",
          code: "POLICY_DENIED",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client().execute(transaction(businessTransactionId));

    expect(result.outcome).toBe("DENIED");
    if (result.outcome !== "DENIED") throw new Error("unreachable");
    expect(result.reason).toContain("exceeds the maximum permitted threshold");
    expect(result.businessTransactionId).toBe(businessTransactionId);
  });

  it("treats a 5xx response as ambiguous, never as a silent success or a silent denial", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: { "content-type": "application/json" } }),
    );

    await expect(client().execute(transaction("ambiguous-1"))).rejects.toBeInstanceOf(ParmanaExecutionAmbiguousError);
  });

  it("treats a 409 response as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "content-type": "application/json" } }),
    );

    await expect(client().execute(transaction("ambiguous-2"))).rejects.toBeInstanceOf(ParmanaExecutionAmbiguousError);
  });

  it("fails closed on a 401 (not treated as denied, not treated as approved)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "content-type": "application/json" } }),
    );

    await expect(client().execute(transaction("auth-fail-1"))).rejects.toThrow(/HTTP 401/);
  });

  it("fails closed on a 200 response with no APPROVED execution decision (malformed response)", async () => {
    const businessTransactionId = "malformed-1";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ businessTransactionId, transaction: { businessTransactionId }, executions: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(client().execute(transaction(businessTransactionId))).rejects.toThrow(/malformed/);
  });
});
