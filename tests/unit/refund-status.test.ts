import { describe, expect, it, vi } from "vitest";

import { executeRefundStatusLookup, parseRefundStatusRequest } from "../../src/server/refund-status.js";

function reconcilerReturning(body: Record<string, unknown>) {
  return { reconcile: vi.fn().mockResolvedValue({ body, head: {}, raw: {} }) };
}

describe("parseRefundStatusRequest", () => {
  it("returns trimmed orderId and refId", () => {
    expect(parseRefundStatusRequest({ orderId: " ORD-1 ", refId: " refid_1 " })).toEqual({
      orderId: "ORD-1",
      refId: "refid_1",
    });
  });

  it("returns null when a field is missing, blank or not a string", () => {
    expect(parseRefundStatusRequest({ orderId: "ORD-1" })).toBeNull();
    expect(parseRefundStatusRequest({ orderId: "ORD-1", refId: "   " })).toBeNull();
    expect(parseRefundStatusRequest({ orderId: 7, refId: "refid_1" })).toBeNull();
    expect(parseRefundStatusRequest(null)).toBeNull();
    expect(parseRefundStatusRequest("ORD-1")).toBeNull();
  });
});

describe("executeRefundStatusLookup", () => {
  it("asks the reconciler for the given order and refId, and reports Paytm's nested status", async () => {
    const reconciler = reconcilerReturning({
      resultInfo: { resultStatus: "PENDING", resultCode: "601", resultMsg: "Refund request was raised for this transaction. But it is pending state." },
    });

    const result = await executeRefundStatusLookup({ orderId: "ORD-1", refId: "refid_1" }, reconciler);

    expect(reconciler.reconcile).toHaveBeenCalledWith({ orderId: "ORD-1", refId: "refid_1" });
    expect(result).toEqual({
      provider: "paytm",
      resultStatus: "PENDING",
      resultCode: "601",
      resultMessage: "Refund request was raised for this transaction. But it is pending state.",
    });
  });

  it("reports UNKNOWN with null code and message when Paytm's body has no result", async () => {
    const result = await executeRefundStatusLookup(
      { orderId: "ORD-1", refId: "refid_1" },
      reconcilerReturning({}),
    );

    expect(result).toEqual({ provider: "paytm", resultStatus: "UNKNOWN", resultCode: null, resultMessage: null });
  });

  it("propagates a reconciler failure rather than reporting a status", async () => {
    const reconciler = { reconcile: vi.fn().mockRejectedValue(new Error("Paytm API HTTP 503")) };

    await expect(
      executeRefundStatusLookup({ orderId: "ORD-1", refId: "refid_1" }, reconciler),
    ).rejects.toThrow("Paytm API HTTP 503");
  });
});
