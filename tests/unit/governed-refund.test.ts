import { afterEach, describe, expect, it, vi } from "vitest";
import { GovernedPaytmRefundService } from "../../src/governed-refund.js";
import { MemoryRefundIdempotencyStore } from "../../src/paytm/idempotency.js";
import type { ParmanaRefundAuthorizer } from "../../src/parmana/refund-authorizer.js";
import { PaytmRefundConnector } from "../../src/paytm/refund.js";

const base = {
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

function authorizerReturning(result: Record<string, unknown>) {
  return {
    authorizeRefund: vi.fn().mockResolvedValue({
      transactionId: "bt-1",
      orderId: base.orderId,
      txnId: base.txnId,
      amount: base.amount,
      raw: {} as never,
      ...result,
    }),
  } as unknown as ParmanaRefundAuthorizer;
}

const approved = {
  decision: { decision: "APPROVED", authorizationId: "auth-2" },
  execution: { success: true, refId: "refid_parmana", resultStatus: "PENDING", resultCode: "601" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GovernedPaytmRefundService", () => {
  it("returns a policy refusal and records the refId as FAILED", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const authorizer = authorizerReturning({ decision: { decision: "DENIED", authorizationId: "", reason: "manager approval required" } });

    const result = await new GovernedPaytmRefundService(authorizer, store).refund(base);

    expect(result.decision).toBe("DENIED");
    expect((await store.get(base.refId))?.status).toBe("FAILED");
  });

  it("never calls Paytm itself after an approval: Parmana already released the refund (no double refund)", async () => {
    const paytmCall = vi.spyOn(PaytmRefundConnector.prototype, "initiateRefund");
    const fetchCall = vi.spyOn(globalThis, "fetch");
    const authorizer = authorizerReturning(approved);

    const result = await new GovernedPaytmRefundService(authorizer).refund(base);

    expect(authorizer.authorizeRefund).toHaveBeenCalledTimes(1);
    expect(paytmCall).not.toHaveBeenCalled();
    expect(fetchCall).not.toHaveBeenCalled();
    expect(result).toEqual({
      decision: "APPROVED",
      authorizationId: "auth-2",
      transactionId: "bt-1",
      refund: approved.execution,
    });
  });

  it("reports a released refund Paytm did not accept, and records it as FAILED", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const authorizer = authorizerReturning({ ...approved, execution: { success: false, resultStatus: "TXN_FAILURE", resultCode: "617" } });

    const result = await new GovernedPaytmRefundService(authorizer, store).refund(base);

    expect(result.decision === "APPROVED" && result.refund.success).toBe(false);
    expect((await store.get(base.refId))?.status).toBe("FAILED");
  });

  it("records SUBMITTED after success and refuses a second request for the same refId without asking Parmana", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const authorizer = authorizerReturning(approved);
    const service = new GovernedPaytmRefundService(authorizer, store);

    await service.refund(base);
    expect((await store.get(base.refId))?.status).toBe("SUBMITTED");

    await expect(service.refund(base)).rejects.toThrow("already submitted");
    expect(authorizer.authorizeRefund).toHaveBeenCalledTimes(1);
  });

  it("marks the refId UNKNOWN when Parmana fails, so it is reconciled, not retried blindly", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const authorizer = { authorizeRefund: vi.fn().mockRejectedValue(new Error("Parmana execution outcome is ambiguous")) } as unknown as ParmanaRefundAuthorizer;

    await expect(new GovernedPaytmRefundService(authorizer, store).refund(base)).rejects.toThrow("ambiguous");
    expect((await store.get(base.refId))?.status).toBe("UNKNOWN");
  });

  it("fails and marks UNKNOWN when an approval carries no execution result", async () => {
    const store = new MemoryRefundIdempotencyStore();
    const authorizer = authorizerReturning({ decision: approved.decision });

    await expect(new GovernedPaytmRefundService(authorizer, store).refund(base)).rejects.toThrow("no execution result");
    expect((await store.get(base.refId))?.status).toBe("UNKNOWN");
  });

  it("G-71: forwards the refund reason to Parmana", async () => {
    const authorizer = authorizerReturning(approved);

    await new GovernedPaytmRefundService(authorizer).refund({ ...base, reason: "Arrived damaged" });

    expect(authorizer.authorizeRefund).toHaveBeenCalledWith(expect.objectContaining({ reason: "Arrived damaged" }));
  });

  it("forwards a signed approval to Parmana unchanged", async () => {
    const approvalArtifact = { payload: { approvalId: "a-1" }, signature: { value: "sig" } };
    const authorizer = authorizerReturning(approved);

    await new GovernedPaytmRefundService(authorizer).refund({ ...base, approvalArtifact });

    expect(authorizer.authorizeRefund).toHaveBeenCalledWith(expect.objectContaining({ approvalArtifact }));
  });
});
