import { describe, expect, it } from "vitest";
import { bindAuthorizedRefund } from "../../src/parmana/authorization.js";

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
