import { describe, expect, it, vi } from "vitest";
import { GovernedPaytmRefundService } from "../../src/governed-refund.js";
import type { ParmanaRefundAuthorizer } from "../../src/parmana/refund-authorizer.js";
import type { PaytmRefundConnector } from "../../src/paytm/refund.js";

const request = {
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

function serviceWithApprovedAuthorization(overrides: Partial<typeof request> = {}) {
  const authorizer = {
    authorizeRefund: vi.fn().mockResolvedValue({
      decision: { decision: "APPROVED", authorizationId: "auth-1" },
      transactionId: "bt-1",
      orderId: request.orderId,
      txnId: request.txnId,
      amount: request.amount,
      raw: {} as never,
      ...overrides,
    }),
  } as unknown as ParmanaRefundAuthorizer;
  const paytm = {
    initiateRefund: vi.fn().mockResolvedValue({ body: {}, head: {}, raw: {} }),
  } as unknown as PaytmRefundConnector;
  return { service: new GovernedPaytmRefundService(authorizer, paytm), paytm };
}

describe("exact authorization binding", () => {
  it("fails closed on an authorized amount mismatch", async () => {
    const { service, paytm } = serviceWithApprovedAuthorization({ amount: "500.01" });
    await expect(service.refund(request)).rejects.toThrow("authorized refund amount mismatch");
    expect(paytm.initiateRefund).not.toHaveBeenCalled();
  });

  it("fails closed on an authorized order mismatch", async () => {
    const { service, paytm } = serviceWithApprovedAuthorization({ orderId: "ORDER-999" });
    await expect(service.refund(request)).rejects.toThrow("authorized orderId mismatch");
    expect(paytm.initiateRefund).not.toHaveBeenCalled();
  });

  it("fails closed on an authorized transaction mismatch", async () => {
    const { service, paytm } = serviceWithApprovedAuthorization({ txnId: "TXN-999" });
    await expect(service.refund(request)).rejects.toThrow("authorized txnId mismatch");
    expect(paytm.initiateRefund).not.toHaveBeenCalled();
  });
});
