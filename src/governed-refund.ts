import { bindAuthorizedRefund } from "./parmana/authorization.js";
import { ParmanaRefundAuthorizer } from "./parmana/refund-authorizer.js";
import { PaytmRefundConnector } from "./paytm/refund.js";
import type { RefundResponse } from "./paytm/types.js";
import { MemoryRefundIdempotencyStore, type RefundIdempotencyStore } from "./paytm/idempotency.js";

export interface GovernedRefundRequest { orderId: string; txnId: string; refId: string; amount: string; reason?: string; signals: { refundEligible: boolean; managerApproved: boolean; fraudCheckPassed: boolean; maximumRefundAmount: number } }
export type GovernedRefundResult =
  | { decision: "DENIED"; authorizationId: string; transactionId: string; reason: string }
  | { decision: "APPROVED"; authorizationId: string; transactionId: string; paytm: RefundResponse };

/** The only application path that may initiate a Paytm refund. */
export class GovernedPaytmRefundService {
  private readonly store: RefundIdempotencyStore;
  constructor(private readonly authorizer: ParmanaRefundAuthorizer, private readonly paytm: PaytmRefundConnector, store?: RefundIdempotencyStore) { this.store = store ?? new MemoryRefundIdempotencyStore(); }

  async refund(request: GovernedRefundRequest): Promise<GovernedRefundResult> {
    const amount = normalizeAmount(request.amount);
    const existing = await this.store.get(request.refId);
    if (existing) {
      assertBinding(existing.orderId, existing.txnId, existing.amount, request.orderId, request.txnId, amount);
      if (["CONFIRMED", "SUBMITTED", "PENDING", "UNKNOWN"].includes(existing.status)) throw new Error("refund already submitted or ambiguous for refId; reconcile status before retrying");
    }

    const authorization = await this.authorizer.authorizeRefund({ refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount: request.amount, signals: request.signals });
    if (authorization.decision.decision === "DENIED") return { decision: "DENIED", authorizationId: authorization.decision.authorizationId, transactionId: authorization.transactionId, reason: authorization.decision.reason };

    bindAuthorizedRefund({ orderId: authorization.orderId, txnId: authorization.txnId, amount: authorization.amount, authorizationId: authorization.decision.authorizationId }, { orderId: request.orderId, txnId: request.txnId, amount: request.amount });

    const claimed = await this.store.claim({ refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount, status: "PENDING" });
    if (!claimed) throw new Error("refund execution already claimed for refId; reconcile status before retrying");

    try {
      const paytm = await this.paytm.initiateRefund({ orderId: request.orderId, txnId: request.txnId, refId: request.refId, amount: request.amount, ...(request.reason?.trim() ? { reason: request.reason } : {}) });
      await this.store.put({ refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount, status: "SUBMITTED" });
      return { decision: "APPROVED", authorizationId: authorization.decision.authorizationId, transactionId: authorization.transactionId, paytm };
    } catch (error) {
      await this.store.put({ refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount, status: "UNKNOWN" });
      throw error;
    }
  }
}

function normalizeAmount(value: string): string { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("refund amount must be positive"); return numeric.toFixed(2); }
function assertBinding(aOrder: string, aTxn: string, aAmount: string, bOrder: string, bTxn: string, bAmount: string): void { if (aOrder !== bOrder || aTxn !== bTxn || aAmount !== bAmount) throw new Error("refId is already bound to a different refund"); }
