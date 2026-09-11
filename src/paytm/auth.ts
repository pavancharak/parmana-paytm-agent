import crypto from "node:crypto";

const PAYTM_IV = "@@@@&&&&####$$$$";

export function assertMerchantKey(merchantKey: string): void {
  if (!merchantKey) throw new Error("PAYTM_MERCHANT_KEY is required");
  if (Buffer.byteLength(merchantKey, "utf8") !== 16) {
    throw new Error("PAYTM_MERCHANT_KEY must be exactly 16 bytes");
  }
}

function encrypt(input: string, merchantKey: string): string {
  assertMerchantKey(merchantKey);
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(merchantKey, "utf8"),
    Buffer.from(PAYTM_IV, "utf8"),
  );
  return Buffer.concat([cipher.update(input, "utf8"), cipher.final()]).toString("base64");
}

function randomSalt(length: number): string {
  return crypto.randomBytes(Math.ceil(length * 3 / 4)).toString("base64").slice(0, length);
}

function calculateHash(params: string, salt: string): string {
  return crypto.createHash("sha256").update(`${params}|${salt}`, "utf8").digest("hex") + salt;
}

/** Paytm's AES-128-CBC checksum scheme used by the current refund integration. */
export function generateChecksum(params: string, merchantKey: string): string {
  const salt = randomSalt(4);
  return encrypt(calculateHash(params, salt), merchantKey);
}

export function canonicalParameterString(params: Record<string, unknown>): string {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key];
      return value === null || value === undefined ? "" : String(value);
    })
    .join("|");
}
