import { describe, expect, it, vi } from "vitest";
import type { BusinessTransaction, ParmanaHttpClient } from "../../src/parmana/client.js";
import { deterministicRefundTransactionId, ParmanaRefundAuthorizer, readRefundExecution } from "../../src/parmana/refund-authorizer.js";

describe("deterministicRefundTransactionId", () => {
  it("maps the same Paytm refId to the same Parmana transaction", () => {
    expect(deterministicRefundTransactionId("REF-123")).toBe(
      deterministicRefundTransactionId("REF-123"),
    );
  });

  it("produces a valid version-4 UUID shape", () => {
    const id = deterministicRefundTransactionId("REF-123");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("separates different logical refunds", () => {
    expect(deterministicRefundTransactionId("REF-123")).not.toBe(
      deterministicRefundTransactionId("REF-124"),
    );
  });
});

const input = {
  refId: "REF-9",
  orderId: "ORDER-9",
  txnId: "TXN-9",
  amount: "12000",
  signals: { refundEligible: true, managerApproved: false, fraudCheckPassed: true, maximumRefundAmount: 100000 },
};

function approvedRecord(businessTransactionId: string, evidence?: Record<string, unknown>) {
  return {
    outcome: "APPROVED" as const,
    businessTransactionId,
    authorizationId: "auth-9",
    trustRecord: { executions: [{ decision: { outcome: "APPROVED" }, ...(evidence ? { evidence } : {}) }] },
  };
}

function fakeClient(policyVersion = "1.1.0") {
  const client = {
    getPolicyInEffect: vi.fn().mockResolvedValue({ name: "customer-refund", version: policyVersion, schemaVersion: "1.0.0" }),
    execute: vi.fn(async (transaction: BusinessTransaction) =>
      approvedRecord(transaction.businessTransactionId, { success: true, attributes: { refId: "refid_x", resultStatus: "PENDING", resultCode: "601" } }),
    ),
    getTrustRecord: vi.fn(),
  };
  return { client, authorizer: new ParmanaRefundAuthorizer(client as unknown as ParmanaHttpClient, "paytm-refund-agent") };
}

describe("ParmanaRefundAuthorizer", () => {
  it("declares the policy version Parmana says is in effect, never a version written into the code", async () => {
    const { client, authorizer } = fakeClient("1.7.3");

    await authorizer.authorizeRefund(input);

    expect(client.getPolicyInEffect).toHaveBeenCalledWith("paytm:refund");
    const sent = client.execute.mock.calls[0]?.[0];
    expect(sent?.policy).toEqual({ name: "customer-refund", version: "1.7.3", schemaVersion: "1.0.0" });
  });

  it("asks Parmana nothing else when the policy in effect cannot be read (fails closed)", async () => {
    const { client, authorizer } = fakeClient();
    client.getPolicyInEffect.mockRejectedValue(new Error("HTTP 409 NO_APPROVED_POLICY_VERSION"));

    await expect(authorizer.authorizeRefund(input)).rejects.toThrow("NO_APPROVED_POLICY_VERSION");
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("sends a signed approval as signals.approvalArtifact with managerApproved true", async () => {
    const { client, authorizer } = fakeClient();
    const approvalArtifact = { payload: { approvalId: "a-1" }, signature: { value: "sig" } };

    await authorizer.authorizeRefund({ ...input, approvalArtifact });

    const signals = client.execute.mock.calls[0]?.[0].signals;
    expect(signals?.["approvalArtifact"]).toEqual(approvalArtifact);
    expect(signals?.["managerApproved"]).toBe(true);
  });

  it("sends no approvalArtifact and keeps the caller's managerApproved when there is no approval", async () => {
    const { client, authorizer } = fakeClient();

    await authorizer.authorizeRefund(input);

    const signals = client.execute.mock.calls[0]?.[0].signals;
    expect(signals).not.toHaveProperty("approvalArtifact");
    expect(signals?.["managerApproved"]).toBe(false);
  });

  it("returns what Paytm reported for the refund Parmana released", async () => {
    const { authorizer } = fakeClient();

    const result = await authorizer.authorizeRefund(input);

    expect(result.execution).toEqual({ success: true, refId: "refid_x", resultStatus: "PENDING", resultCode: "601" });
  });
});

describe("readRefundExecution", () => {
  it("reads success and the Paytm identifiers from the last execution's evidence", () => {
    expect(
      readRefundExecution({
        executions: [
          { evidence: { success: true, attributes: { refId: "old" } } },
          { evidence: { success: false, attributes: { refId: "refid_2", resultStatus: "TXN_FAILURE", resultCode: 617 } } },
        ],
      }),
    ).toEqual({ success: false, refId: "refid_2", resultStatus: "TXN_FAILURE" });
  });

  it("throws when an approved record has no execution evidence, so the outcome is reconciled", () => {
    expect(() => readRefundExecution({ executions: [{ decision: { outcome: "APPROVED" } }] })).toThrow("outcome is unknown");
    expect(() => readRefundExecution({})).toThrow("outcome is unknown");
  });
});
