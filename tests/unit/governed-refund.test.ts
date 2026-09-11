import { describe, expect, it, vi } from "vitest";
import { GovernedPaytmRefundService } from "../../src/governed-refund.js";
import type { ParmanaRefundAuthorizer } from "../../src/parmana/refund-authorizer.js";
import type { PaytmRefundConnector } from "../../src/paytm/refund.js";

const base = {
  orderId: "ORDER-123",
  txnId: "TXN-123",
  refId: "REF-123",
  amount: "500.00",
  signals: {
    refundEligible: true,
    managerApproved: true,
    fraudCheckPassed: true,
    maximumRefundAmount: 1000,
  },
};

describe("GovernedPaytmRefundService", () => {
  it("does not call Paytm when the same policy denies the payload", async () => {
    const authorizer = {
      authorizeRefund: vi.fn().mockResolvedValue({
        decision: { decision: "DENIED", authorizationId: "auth-1", reason: "manager approval required" },
        transactionId: "bt-1",
        orderId: base.orderId,
        txnId: base.txnId,
        amount: base.amount,
        raw: {} as never,
      }),
    } as unknown as ParmanaRefundAuthorizer;
    const paytm = { initiateRefund: vi.fn() } as unknown as PaytmRefundConnector;

    const result = await new GovernedPaytmRefundService(authorizer, paytm).refund({
      ...base,
      signals: { ...base.signals, managerApproved: false },
    });

    expect(result.decision).toBe("DENIED");
    expect(paytm.initiateRefund).not.toHaveBeenCalled();
  });

  it("calls Paytm exactly once after an approval", async () => {
    const authorizer = {
      authorizeRefund: vi.fn().mockResolvedValue({
        decision: { decision: "APPROVED", authorizationId: "auth-2" },
        transactionId: "bt-2",
        orderId: base.orderId,
        txnId: base.txnId,
        amount: base.amount,
        raw: {} as never,
      }),
    } as unknown as ParmanaRefundAuthorizer;
    const paytm = {
      initiateRefund: vi.fn().mockResolvedValue({ body: {}, head: {}, raw: {} }),
    } as unknown as PaytmRefundConnector;

    const result = await new GovernedPaytmRefundService(authorizer, paytm).refund(base);

    expect(result.decision).toBe("APPROVED");
    expect(paytm.initiateRefund).toHaveBeenCalledTimes(1);
    expect(paytm.initiateRefund).toHaveBeenCalledWith({
      orderId: base.orderId,
      txnId: base.txnId,
      refId: base.refId,
      amount: base.amount,
    });
  });
});
