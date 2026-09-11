import { describe, expect, it } from "vitest";
import { assertMerchantKey, generateChecksum } from "../../src/paytm/auth.js";

describe("Paytm authentication", () => {
  it("requires the Paytm AES key to be exactly 16 bytes", () => {
    expect(() => assertMerchantKey("short")).toThrow("exactly 16 bytes");
    expect(() => assertMerchantKey("1234567890123456")).not.toThrow();
  });

  it("generates an encrypted checksum without exposing the merchant key", () => {
    const checksum = generateChecksum('{"amount":"500.00"}', "1234567890123456");
    expect(checksum).toBeTypeOf("string");
    expect(checksum.length).toBeGreaterThan(0);
  });
});
