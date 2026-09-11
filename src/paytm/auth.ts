import crypto from "node:crypto";

/**
 * Paytm checksum helper.
 *
 * Paytm merchant credentials are never embedded in the request object by the
 * caller. The connector owns checksum generation so an agent cannot bypass
 * the authenticated execution path.
 */
export function generateChecksum(payload: string, merchantKey: string): string {
  if (!merchantKey) throw new Error("PAYTM_MERCHANT_KEY is required");
  return crypto
    .createHmac("sha256", merchantKey)
    .update(payload, "utf8")
    .digest("base64");
}

export function assertSafeCredential(value: string, name: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
}
