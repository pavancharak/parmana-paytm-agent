import { describe, expect, it, vi } from "vitest";
import { GovernedPaytmRefundService } from "../../src/governed-refund.js";
import { MemoryRefundIdempotencyStore } from "../../src/paytm/idempotency.js";
import type { ParmanaRefundAuthorizer } from "../../src/parmana/refund-authorizer.js";

const request = {
  orderId: "ORDER-123",
  txnId: "TXN-123",
  refId: "REF-123",
  amount: "500.00",
  signals: {
    refundEligible: true,
    managerApproved: false,
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
      execution: { success: true },
      raw: {} as never,
      ...overrides,
    }),
  } as unknown as ParmanaRefundAuthorizer;
  const store = new MemoryRefundIdempotencyStore();
  return { service: new GovernedPaytmRefundService(authorizer, store), store };
}

// Parmana has already released the refund when it answers, so a mismatch
// cannot stop it: it must fail loudly and leave the refId for reconciliation.
describe("exact authorization binding", () => {
  it("fails closed on an authorized amount mismatch", async () => {
    const { service, store } = serviceWithApprovedAuthorization({ amount: "500.01" });
    await expect(service.refund(request)).rejects.toThrow("authorized refund amount mismatch");
    expect((await store.get(request.refId))?.status).toBe("UNKNOWN");
  });

  it("fails closed on an authorized order mismatch", async () => {
    const { service, store } = serviceWithApprovedAuthorization({ orderId: "ORDER-999" });
    await expect(service.refund(request)).rejects.toThrow("authorized orderId mismatch");
    expect((await store.get(request.refId))?.status).toBe("UNKNOWN");
  });

  it("fails closed on an authorized transaction mismatch", async () => {
    const { service, store } = serviceWithApprovedAuthorization({ txnId: "TXN-999" });
    await expect(service.refund(request)).rejects.toThrow("authorized txnId mismatch");
    expect((await store.get(request.refId))?.status).toBe("UNKNOWN");
  });
});
