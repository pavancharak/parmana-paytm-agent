import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindAuthorizedRefund,
  canonicalPaytmAuthorizationString,
  verifyPaytmAuthorizationSignature,
} from "../../src/parmana/authorization.js";

describe("refund authorization binding", () => {
  const approved = {
    orderId: "ORDER-123",
    txnId: "TXN-123",
    amount: "500.00",
    authorizationId: "auth-1",
  };

  it("accepts the exact authorized parameters", () => {
    expect(() => bindAuthorizedRefund(approved, {
      orderId: "ORDER-123",
      txnId: "TXN-123",
      amount: "500",
    })).not.toThrow();
  });

  it("fails closed when the amount changes", () => {
    expect(() => bindAuthorizedRefund(approved, {
      orderId: "ORDER-123",
      txnId: "TXN-123",
      amount: "50000",
    })).toThrow("authorized refund amount mismatch");
  });

  it("fails closed when the order changes", () => {
    expect(() => bindAuthorizedRefund(approved, {
      orderId: "ORDER-999",
      txnId: "TXN-123",
      amount: "500",
    })).toThrow("authorized orderId mismatch");
  });
});

/**
 * canonicalPaytmAuthorizationString is a cross-repo contract (ADR-0009
 * Phase 2B): AgentLabsBuildathon's GatewayPaytmAdapter and this
 * repo must each build byte-for-byte the same string from the same
 * inputs, or every signature that codebase produces fails
 * verification here. This is a regression test against silent format
 * drift, not behavior this file is free to change unilaterally.
 */
describe("canonicalPaytmAuthorizationString", () => {
  const BASE_INPUT = {
    businessTransactionId: "btx-1",
    action: "paytm-refund",
    orderId: "order-1",
    txnId: "txn-1",
    amount: "500.00",
    expiresAt: 1_700_000_000_000,
  };

  it("produces a fixed, pipe-delimited format in a fixed field order", () => {
    expect(canonicalPaytmAuthorizationString(BASE_INPUT)).toBe(
      "btx-1|paytm-refund|order-1|txn-1|500.00|1700000000000",
    );
  });

  it("changing any single field changes the resulting string", () => {
    const base = canonicalPaytmAuthorizationString(BASE_INPUT);
    expect(canonicalPaytmAuthorizationString({ ...BASE_INPUT, amount: "999.00" })).not.toBe(base);
    expect(canonicalPaytmAuthorizationString({ ...BASE_INPUT, expiresAt: BASE_INPUT.expiresAt + 1 })).not.toBe(base);
  });
});

describe("verifyPaytmAuthorizationSignature", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const PEM = publicKey.export({ format: "pem", type: "spki" }).toString();
  const originalFetch = globalThis.fetch;

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

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ pem: PEM }), { status: 200 }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const VALID = {
    businessTransactionId: "btx-1",
    action: "paytm-refund",
    orderId: "order-1",
    txnId: "txn-1",
    amount: "500.00",
    expiresAt: Date.now() + 60_000,
  };

  it("accepts a genuinely signed, unexpired authorization", async () => {
    await expect(
      verifyPaytmAuthorizationSignature({
        parmanaBaseUrl: "https://parmana.example.com",
        timeoutMs: 5_000,
        keyId: "default",
        signature: signFor(VALID),
        ...VALID,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects an expired authorization, even though it was genuinely signed", async () => {
    const expired = { ...VALID, expiresAt: Date.now() - 1_000 };

    await expect(
      verifyPaytmAuthorizationSignature({
        parmanaBaseUrl: "https://parmana.example.com",
        timeoutMs: 5_000,
        keyId: "default",
        signature: signFor(expired),
        ...expired,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("rejects a request whose claimed amount doesn't match what was signed -- proves the shared secret alone can no longer forge a refund", async () => {
    const signature = signFor({ ...VALID, amount: "1.00" });

    await expect(
      verifyPaytmAuthorizationSignature({
        parmanaBaseUrl: "https://parmana.example.com",
        timeoutMs: 5_000,
        keyId: "default",
        signature,
        ...VALID, // amount here is "500.00", signature was over "1.00"
      }),
    ).rejects.toThrow(/signature is invalid/);
  });

  it("rejects a signature produced by a different key entirely", async () => {
    const { privateKey: otherKey } = generateKeyPairSync("ed25519");
    const canonical = canonicalPaytmAuthorizationString(VALID);
    const wrongSignature = sign(null, Buffer.from(canonical, "utf8"), otherKey).toString("base64");

    await expect(
      verifyPaytmAuthorizationSignature({
        parmanaBaseUrl: "https://parmana.example.com",
        timeoutMs: 5_000,
        keyId: "default",
        signature: wrongSignature,
        ...VALID,
      }),
    ).rejects.toThrow(/signature is invalid/);
  });
});
