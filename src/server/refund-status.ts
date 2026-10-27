import type { PaytmRefundReconciler } from "../paytm/reconciliation.js";
import { readPaytmResult } from "../paytm/result.js";

/**
 * Read-only refund status lookup for POST /connector/paytm-refund-status.
 *
 * Parmana calls this after an execution whose outcome is unknown, to learn
 * what Paytm recorded for that refId. It never initiates or changes a refund:
 * the only Paytm call is the status inquiry behind PaytmRefundReconciler.
 */
export interface RefundStatusRequest {
  readonly orderId: string;
  readonly refId: string;
}

export interface RefundStatusResult {
  readonly provider: "paytm";
  readonly resultStatus: string;
  readonly resultCode: string | null;
  readonly resultMessage: string | null;
}

/** Returns the trimmed request, or null when a required field is missing. */
export function parseRefundStatusRequest(body: unknown): RefundStatusRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  const orderId = typeof candidate.orderId === "string" ? candidate.orderId.trim() : "";
  const refId = typeof candidate.refId === "string" ? candidate.refId.trim() : "";
  if (!orderId || !refId) return null;
  return { orderId, refId };
}

export async function executeRefundStatusLookup(
  request: RefundStatusRequest,
  reconciler: Pick<PaytmRefundReconciler, "reconcile">,
): Promise<RefundStatusResult> {
  const status = await reconciler.reconcile(request);
  const outcome = readPaytmResult(status.body);

  return {
    provider: "paytm",
    resultStatus: outcome.status,
    resultCode: outcome.code,
    resultMessage: outcome.message,
  };
}
