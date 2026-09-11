import type { PaytmTransport, RefundRequest, RefundResponse, RefundStatusRequest, RefundStatusResponse } from "./types.js";

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeAmount(amount: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw new Error("refund amount must be positive");
  return value.toFixed(2);
}

export class PaytmRefundConnector {
  constructor(private readonly client: PaytmTransport) {}

  async initiateRefund(request: RefundRequest): Promise<RefundResponse> {
    const orderId = requireNonEmpty(request.orderId, "orderId");
    const txnId = requireNonEmpty(request.txnId, "txnId");
    const refId = requireNonEmpty(request.refId, "refId");
    const refundAmount = normalizeAmount(request.amount);

    const body: Record<string, unknown> = {
      txnType: "REFUND",
      orderId,
      txnId,
      refId,
      refundAmount,
    };
    if (request.reason?.trim()) body.comments = request.reason.trim();

    return this.client.post<RefundResponse>("/refund/apply", body);
  }

  async getRefundStatus(request: RefundStatusRequest): Promise<RefundStatusResponse> {
    const orderId = requireNonEmpty(request.orderId, "orderId");
    const body: Record<string, unknown> = { orderId };
    if (request.refId?.trim()) body.refId = request.refId.trim();

    return this.client.post<RefundStatusResponse>("/v2/refund/status", body);
  }
}
