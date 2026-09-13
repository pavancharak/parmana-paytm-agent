import { verify } from "node:crypto";

import { fetchParmanaPublicKey } from "./keys.js";

/**
 * Builds the exact byte sequence GatewayPaytmAdapter signs (ADR-0009
 * Phase 2B, AgentLabsBuildathon repo,
 * packages/connector-paytm/src/PaytmTypes.ts's own copy of this
 * function). Must stay byte-for-byte identical to that copy -- if you
 * change this, the Parmana-side function must change identically, or
 * every signature Parmana produces will fail verification here.
 * Pipe-delimited, not JSON: no key-ordering ambiguity to keep in sync
 * across two independently-maintained repos.
 */
export function canonicalPaytmAuthorizationString(input: {
  businessTransactionId: string;
  action: string;
  orderId: string;
  txnId: string;
  amount: string;
  expiresAt: number;
}): string {
  return [
    input.businessTransactionId,
    input.action,
    input.orderId,
    input.txnId,
    input.amount,
    String(input.expiresAt),
  ].join("|");
}

/**
 * Verifies the authorization signature GatewayPaytmAdapter attaches to
 * a POST /connector/paytm-refund request. Fetches Parmana's public key
 * fresh from GET /keys/:keyId (no local caching of key material in
 * this process -- the network round trip is cheap relative to a
 * refund, and Parmana's own key rotation is then honored automatically
 * with no coordinated deploy on this side).
 *
 * Throws (never returns false) on any failure -- expired, invalid, or
 * unreachable key discovery -- mirroring
 * executeAuthorizedConnectorRequest's existing convention of throwing
 * a plain Error for every validation failure, uniformly surfaced as
 * HTTP 500 by this service's request handler.
 */
export async function verifyPaytmAuthorizationSignature(input: {
  parmanaBaseUrl: string;
  timeoutMs: number;
  businessTransactionId: string;
  action: string;
  orderId: string;
  txnId: string;
  amount: string;
  expiresAt: number;
  signature: string;
  keyId: string;
}): Promise<void> {
  if (!Number.isFinite(input.expiresAt) || Date.now() > input.expiresAt) {
    throw new Error("authorization signature has expired");
  }

  const publicKey = await fetchParmanaPublicKey(
    input.parmanaBaseUrl,
    input.keyId,
    input.timeoutMs,
  );

  const canonical = canonicalPaytmAuthorizationString({
    businessTransactionId: input.businessTransactionId,
    action: input.action,
    orderId: input.orderId,
    txnId: input.txnId,
    amount: input.amount,
    expiresAt: input.expiresAt,
  });

  const signatureValid = verify(
    null,
    Buffer.from(canonical, "utf8"),
    publicKey,
    Buffer.from(input.signature, "base64"),
  );

  if (!signatureValid) {
    throw new Error("authorization signature is invalid");
  }
}

export type AuthorizationDecision =
  | { decision: "APPROVED"; authorizationId: string }
  | { decision: "DENIED"; authorizationId: string; reason: string };

export interface AuthorizedRefund {
  orderId: string;
  txnId: string;
  amount: string;
  authorizationId: string;
}

export interface ParmanaRefundAuthorizer {
  authorizeRefund(input: {
    orderId: string;
    txnId: string;
    amount: string;
    signals: Record<string, unknown>;
  }): Promise<AuthorizationDecision>;
}

/**
 * Binds the exact parameters evaluated by Parmana to the eventual side effect.
 * A changed order, transaction or amount cannot reuse an earlier approval.
 */
export function bindAuthorizedRefund(
  approved: AuthorizedRefund,
  requested: { orderId: string; txnId: string; amount: string },
): void {
  if (approved.orderId !== requested.orderId) throw new Error("authorized orderId mismatch");
  if (approved.txnId !== requested.txnId) throw new Error("authorized txnId mismatch");
  if (Number(approved.amount).toFixed(2) !== Number(requested.amount).toFixed(2)) {
    throw new Error("authorized refund amount mismatch");
  }
}
