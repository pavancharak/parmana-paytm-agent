import { describe, expect, it } from "vitest";
import { deterministicRefundTransactionId } from "../../src/parmana/refund-authorizer.js";

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
