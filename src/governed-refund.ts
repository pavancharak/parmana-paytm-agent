import { bindAuthorizedRefund } from "./parmana/authorization.js";
import { ParmanaRefundAuthorizer, type RefundExecution } from "./parmana/refund-authorizer.js";
import { MemoryRefundIdempotencyStore, type RefundIdempotencyStore } from "./paytm/idempotency.js";

export interface GovernedRefundRequest { orderId: string; txnId: string; refId: string; amount: string; reason?: string; signals: { refundEligible: boolean; managerApproved: boolean; fraudCheckPassed: boolean; maximumRefundAmount: number }; approvalArtifact?: Record<string, unknown> }
export type GovernedRefundResult =
  | { decision: "DENIED"; authorizationId: string; transactionId: string; reason: string }
  | { decision: "APPROVED"; authorizationId: string; transactionId: string; refund: RefundExecution };

/**
 * The only application path that may request a Paytm refund.
 *
 * It asks Parmana (POST /execute). When Parmana approves, Parmana itself
 * releases the refund to its Paytm connector inside that same call, and
 * the signed Trust Record it returns holds what Paytm reported. This
 * service therefore never calls Paytm: doing so as well would refund the
 * customer twice, under a different refId each time, so Paytm would not
 * catch the duplicate.
 */
export class GovernedPaytmRefundService {
  private readonly store: RefundIdempotencyStore;
  constructor(private readonly authorizer: ParmanaRefundAuthorizer, store?: RefundIdempotencyStore) { this.store = store ?? new MemoryRefundIdempotencyStore(); }

  async refund(request: GovernedRefundRequest): Promise<GovernedRefundResult> {
    const amount = normalizeAmount(request.amount);
    const existing = await this.store.get(request.refId);
    if (existing) {
      assertBinding(existing.orderId, existing.txnId, existing.amount, request.orderId, request.txnId, amount);
      if (["CONFIRMED", "SUBMITTED", "PENDING", "UNKNOWN"].includes(existing.status)) throw new Error("refund already submitted or ambiguous for refId; reconcile status before retrying");
    }

    // Claimed before asking Parmana, because an approval is also the
    // release of the refund. A refId refused earlier (FAILED) may retry.
    const record = { refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount };
    if (existing) await this.store.put({ ...record, status: "PENDING" });
    else if (!(await this.store.claim({ ...record, status: "PENDING" }))) throw new Error("refund execution already claimed for refId; reconcile status before retrying");

    let authorization;
    try {
      authorization = await this.authorizer.authorizeRefund({ refId: request.refId, orderId: request.orderId, txnId: request.txnId, amount: request.amount, signals: request.signals, ...(request.approvalArtifact !== undefined ? { approvalArtifact: request.approvalArtifact } : {}), ...(request.reason !== undefined ? { reason: request.reason } : {}) });
    } catch (error) {
      await this.store.put({ ...record, status: "UNKNOWN" });
      throw error;
    }

    if (authorization.decision.decision === "DENIED") {
      await this.store.put({ ...record, status: "FAILED" });
      return { decision: "DENIED", authorizationId: authorization.decision.authorizationId, transactionId: authorization.transactionId, reason: authorization.decision.reason };
    }

    // Parmana has already released the refund. A binding mismatch here
    // cannot undo it; it marks the record UNKNOWN for reconciliation.
    try {
      bindAuthorizedRefund({ orderId: authorization.orderId, txnId: authorization.txnId, amount: authorization.amount, authorizationId: authorization.decision.authorizationId }, { orderId: request.orderId, txnId: request.txnId, amount: request.amount });
      if (!authorization.execution) throw new Error("Parmana approved the refund but returned no execution result; reconcile before retrying");
    } catch (error) {
      await this.store.put({ ...record, status: "UNKNOWN" });
      throw error;
    }

    await this.store.put({ ...record, status: authorization.execution.success ? "SUBMITTED" : "FAILED" });
    return { decision: "APPROVED", authorizationId: authorization.decision.authorizationId, transactionId: authorization.transactionId, refund: authorization.execution };
  }
}

function normalizeAmount(value: string): string { const numeric = Number(value); if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("refund amount must be positive"); return numeric.toFixed(2); }
function assertBinding(aOrder: string, aTxn: string, aAmount: string, bOrder: string, bTxn: string, bAmount: string): void { if (aOrder !== bOrder || aTxn !== bTxn || aAmount !== bAmount) throw new Error("refId is already bound to a different refund"); }
