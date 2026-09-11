import type { PaytmRefundConnector } from "./refund.js";
import type { RefundStatusResponse } from "./types.js";

export interface RefundReconciliationInput {
  orderId: string;
  refId: string;
}

/**
 * Reconcile an ambiguous refund outcome before any retry is considered.
 * This intentionally performs no automatic retry: duplicate financial actions
 * require an explicit, separately governed decision.
 */
export class PaytmRefundReconciler {
  constructor(private readonly paytm: PaytmRefundConnector) {}

  async reconcile(input: RefundReconciliationInput): Promise<RefundStatusResponse> {
    const orderId = input.orderId.trim();
    const refId = input.refId.trim();
    if (!orderId) throw new Error("orderId is required");
    if (!refId) throw new Error("refId is required");

    return this.paytm.getRefundStatus({ orderId, refId });
  }
}
