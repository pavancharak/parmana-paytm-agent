import crypto from "node:crypto";
import { assertMerchantKey } from "./auth.js";

export interface PaytmWebhookVerificationInput {
  payload: Record<string, unknown>;
  checksum: string;
  merchantKey: string;
}

export interface VerifiedRefundWebhook {
  orderId: string;
  refId?: string;
  refundAmount?: string;
  status: string;
  payload: Record<string, unknown>;
}

/**
 * Verifies a Paytm callback before it is allowed to affect local state.
 * The callback is treated as external evidence, never as Parmana authority.
 */
export function verifyPaytmChecksum(input: PaytmWebhookVerificationInput): boolean {
  assertMerchantKey(input.merchantKey);
  if (!input.checksum) return false;

  const body = { ...input.payload };
  delete body.CHECKSUMHASH;
  delete body.checksum;

  // Paytm callback checksum verification uses the same merchant-key AES
  // checksum family as request signing. Importing the maintained verifier
  // implementation is intentionally avoided so the connector has no
  // runtime dependency on Paytm's SDK.
  const encrypted = decrypt(input.checksum, input.merchantKey);
  const salt = encrypted.slice(-4);
  const hash = encrypted.slice(0, -4);
  const parameterString = Object.keys(body)
    .sort()
    .map((key) => {
      const value = body[key];
      return value === null || value === undefined ? "" : String(value);
    })
    .join("|");
  const expected = crypto.createHash("sha256").update(`${parameterString}|${salt}`, "utf8").digest("hex");

  return timingSafeEqual(hash, expected);
}

export function parseRefundWebhook(input: PaytmWebhookVerificationInput): VerifiedRefundWebhook {
  if (!verifyPaytmChecksum(input)) throw new Error("invalid Paytm webhook checksum");

  const orderId = String(input.payload.ORDERID ?? input.payload.orderId ?? "").trim();
  const status = String(input.payload.STATUS ?? input.payload.status ?? "").trim();
  const refId = String(input.payload.REFID ?? input.payload.refId ?? "").trim();
  const refundAmount = String(input.payload.REFUNDAMOUNT ?? input.payload.refundAmount ?? "").trim();

  if (!orderId) throw new Error("Paytm webhook missing orderId");
  if (!status) throw new Error("Paytm webhook missing status");

  return {
    orderId,
    ...(refId ? { refId } : {}),
    ...(refundAmount ? { refundAmount } : {}),
    status,
    payload: input.payload,
  };
}

function decrypt(value: string, merchantKey: string): string {
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(merchantKey, "utf8"),
    Buffer.from("@@@@&&&&####$$$$", "utf8"),
  );
  return Buffer.concat([decipher.update(Buffer.from(value, "base64")), decipher.final()]).toString("utf8");
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
