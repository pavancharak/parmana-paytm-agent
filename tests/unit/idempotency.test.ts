import { describe, expect, it } from "vitest";
import { MemoryRefundIdempotencyStore } from "../../src/paytm/idempotency.js";

describe("refund idempotency", () => {
  it("rejects reuse of a refId for different financial parameters", async () => {
    const store = new MemoryRefundIdempotencyStore();
    await store.put({ refId: "REF-1", orderId: "ORDER-1", txnId: "TXN-1", amount: "500.00", status: "PENDING" });

    await expect(store.put({
      refId: "REF-1",
      orderId: "ORDER-1",
      txnId: "TXN-1",
      amount: "500.01",
      status: "PENDING",
    })).rejects.toThrow("refId is already bound");
  });

  it("returns the existing record for a known refId", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const record = { refId: "REF-1", orderId: "ORDER-1", txnId: "TXN-1", amount: "500.00", status: "SUBMITTED" as const };
    await store.put(record);
    await expect(store.get("REF-1")).resolves.toEqual(record);
  });
});
