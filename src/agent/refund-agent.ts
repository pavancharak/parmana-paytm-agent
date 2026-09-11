import crypto from "node:crypto";
import { GovernedPaytmRefundService, type GovernedRefundRequest } from "../governed-refund.js";

/**
 * Agent-facing capability. It can propose a refund payload, but it has no
 * direct Paytm client. Every proposal is routed through GovernedPaytmRefundService.
 */
export class RefundAgent {
  constructor(private readonly governedRefund: GovernedPaytmRefundService) {}

  async proposeRefund(input: Omit<GovernedRefundRequest, "refId"> & { refId?: string }) {
    const refId = input.refId?.trim() || `PARMANA-${crypto.randomUUID()}`;
    return this.governedRefund.refund({ ...input, refId });
  }
}
