import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { canonicalPaytmAuthorizationString } from "../../src/parmana/authorization.js";
import { PaytmRefundConnector } from "../../src/paytm/refund.js";
import type { PaytmTransport } from "../../src/paytm/types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ format: "pem", type: "spki" }).toString();

const REQUIRED_ENV: Record<string, string> = {
  AGENT_API_KEY: "test-agent-key",
  PAYTM_CONNECTOR_SHARED_SECRET: "test-shared-secret",
  PARMANA_API_URL: "https://parmana.example.com",
  PARMANA_API_KEY: "test-parmana-key",
  PARMANA_PRINCIPAL_ID: "test-principal",
  PAYTM_MERCHANT_ID: "test-merchant",
  PAYTM_MERCHANT_KEY: "0123456789abcdef", // exactly 16 bytes, required by assertMerchantKey
  PAYTM_ENVIRONMENT: "staging",
  // GAP-3: only needed so loadConfig()'s own required() check (module
  // load, beforeAll below) doesn't throw -- the fake audit recorder
  // this file injects into every executeAuthorizedConnectorRequest()
  // call never actually opens a Postgres connection with it.
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
};

// GAP-3: a no-op stand-in for recordPaytmAgentAuditEvent, injected into
// every call below so these unit tests never touch a real Postgres
// connection -- mirrors fakeConnector()'s own reasoning for
// PaytmRefundConnector.
async function fakeAuditRecorder(): Promise<void> {}

// executeAuthorizedConnectorRequest lives in src/server/handler.ts,
// whose module scope constructs real ParmanaHttpClient/PaytmHttpClient/
// etc. singletons via loadConfig() -- none of which this test exercises
// (the function under test takes its own connector argument), but
// importing the module still requires these env vars to be set first,
// so a dynamic import happens after setting them, in beforeAll.
let executeAuthorizedConnectorRequest: typeof import("../../src/server/handler.js")["executeAuthorizedConnectorRequest"];
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }
  ({ executeAuthorizedConnectorRequest } = await import("../../src/server/handler.js"));
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fakeConnector(): PaytmRefundConnector {
  const transport: PaytmTransport = {
    post: vi.fn().mockResolvedValue({
      body: { resultStatus: "S", resultCode: "00" },
      head: {},
      raw: {},
    }),
  };
  return new PaytmRefundConnector(transport);
}

function signFor(input: {
  businessTransactionId: string;
  action: string;
  orderId: string;
  txnId: string;
  amount: string;
  expiresAt: number;
}): string {
  const canonical = canonicalPaytmAuthorizationString(input);
  return sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64");
}

function requestBody(overrides: {
  businessTransactionId?: string;
  amount?: string;
  expiresAt?: number;
  signature?: string;
  keyId?: string;
  omitExpiresAt?: boolean;
  omitSignatureFields?: boolean;
} = {}) {
  const businessTransactionId = overrides.businessTransactionId ?? "btx-1";
  const amount = overrides.amount ?? "500.00";
  const expiresAt = overrides.expiresAt ?? Date.now() + 60_000;

  const signed = {
    businessTransactionId,
    action: "paytm-refund",
    orderId: "order-1",
    txnId: "txn-1",
    amount,
    expiresAt,
  };

  return {
    transaction: {
      businessTransactionId,
      intent: {
        action: "paytm-refund",
        target: "paytm://orders/order-1",
        parameters: { orderId: "order-1", txnId: "txn-1", refId: "refid-1", amount },
      },
    },
    authorization: {
      payload: overrides.omitExpiresAt
        ? { businessTransactionId }
        : { businessTransactionId, expiresAt },
      ...(overrides.omitSignatureFields
        ? {}
        : {
            signature: overrides.signature ?? signFor(signed),
            keyId: overrides.keyId ?? "default",
          }),
    },
  };
}

describe("executeAuthorizedConnectorRequest (ADR-0009 Phase 2B)", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    // A fresh Response per call -- Response.json() can only be read
    // once per instance, and multiple tests each fetch the key.
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        () => new Response(JSON.stringify({ pem: PEM }), { status: 200 }),
      ) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("executes the refund when the authorization is genuinely signed and unexpired", async () => {
    const result = await executeAuthorizedConnectorRequest(requestBody(), fakeConnector(), fakeAuditRecorder);

    expect(result.success).toBe(true);
    expect(result.businessTransactionId).toBe("btx-1");
  });

  it("rejects when authorization.signature is missing entirely", async () => {
    await expect(
      executeAuthorizedConnectorRequest(
        requestBody({ omitSignatureFields: true }),
        fakeConnector(),
        fakeAuditRecorder,
      ),
    ).rejects.toThrow(/authorization\.signature is required/);
  });

  it("rejects an expired signature, even though it was genuinely signed", async () => {
    await expect(
      executeAuthorizedConnectorRequest(
        requestBody({ expiresAt: Date.now() - 1_000 }),
        fakeConnector(),
        fakeAuditRecorder,
      ),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a tampered amount -- the signature was produced over a different amount than the one in the request", async () => {
    const signed = {
      businessTransactionId: "btx-1",
      action: "paytm-refund",
      orderId: "order-1",
      txnId: "txn-1",
      amount: "1.00", // signed for 1.00 ...
      expiresAt: Date.now() + 60_000,
    };

    await expect(
      executeAuthorizedConnectorRequest(
        requestBody({ amount: "999999.00", signature: signFor(signed) }), // ... but claiming 999999.00
        fakeConnector(),
        fakeAuditRecorder,
      ),
    ).rejects.toThrow(/signature is invalid/);
  });

  it("this is the exact exploit being closed: a request with only the correct shared secret (verified by the caller of this function, not here) and a self-chosen amount is rejected once it also needs a valid signature", async () => {
    // executeAuthorizedConnectorRequest is only ever reached after the
    // shared-secret bearer check in requestHandler -- this test
    // documents that possessing that secret is no longer sufficient by
    // itself: a request with no signature at all is refused here, even
    // though it would have been accepted before this fix.
    await expect(
      executeAuthorizedConnectorRequest(
        requestBody({ omitSignatureFields: true, amount: "999999.00" }),
        fakeConnector(),
        fakeAuditRecorder,
      ),
    ).rejects.toThrow();
  });

  it("(GAP-3) records authorization.verified then execution.completed, in order, on a successful refund", async () => {
    const events: string[] = [];
    const recordAuditEvent = vi.fn(async (event: { type: string }) => {
      events.push(event.type);
    });

    await executeAuthorizedConnectorRequest(requestBody(), fakeConnector(), recordAuditEvent);

    expect(events).toEqual(["authorization.verified", "execution.completed"]);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ businessTransactionId: "btx-1", action: "paytm-refund" }),
    );
  });

  it("(GAP-3) records only execution.rejected, with the verification failure as the reason, when signature verification fails -- never authorization.verified", async () => {
    const events: string[] = [];
    const recordAuditEvent = vi.fn(async (event: { type: string; reason?: string }) => {
      events.push(event.type);
    });

    // Reaches verifyPaytmAuthorizationSignature itself (unlike
    // omitSignatureFields/missing-parameter cases, which throw earlier,
    // from this function's own synchronous field checks -- before the
    // try/catch this audit wrapping wraps around that call).
    await expect(
      executeAuthorizedConnectorRequest(
        requestBody({ expiresAt: Date.now() - 1_000 }),
        fakeConnector(),
        recordAuditEvent,
      ),
    ).rejects.toThrow(/expired/);

    expect(events).toEqual(["execution.rejected"]);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringMatching(/expired/),
      }),
    );
  });

  it("(GAP-3) records execution.rejected with the Paytm failure reason when the authorization verifies but Paytm itself declines the refund", async () => {
    const events: string[] = [];
    const recordAuditEvent = vi.fn(async (event: { type: string; reason?: string }) => {
      events.push(event.type);
    });

    const decliningTransport: PaytmTransport = {
      post: vi.fn().mockResolvedValue({
        body: { resultStatus: "F", resultCode: "334" },
        head: {},
        raw: {},
      }),
    };

    const result = await executeAuthorizedConnectorRequest(
      requestBody(),
      new PaytmRefundConnector(decliningTransport),
      recordAuditEvent,
    );

    expect(result.success).toBe(false);
    expect(events).toEqual(["authorization.verified", "execution.rejected"]);
    expect(recordAuditEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "execution.rejected",
        reason: expect.stringContaining("resultStatus=F"),
      }),
    );
  });
});
