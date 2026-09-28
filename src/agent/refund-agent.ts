import crypto from "node:crypto";
import { GovernedPaytmRefundService, type GovernedRefundRequest } from "../governed-refund.js";

/**
 * Agent-facing capability. It can propose a refund payload, but it has no
 * Paytm client. Every proposal is routed through GovernedPaytmRefundService,
 * and only Parmana releases a refund to Paytm.
 */
export class RefundAgent {
  constructor(private readonly governedRefund: GovernedPaytmRefundService) {}

  async proposeRefund(input: Omit<GovernedRefundRequest, "refId"> & { refId?: string }) {
    const artifact: unknown = input.approvalArtifact;
    if (artifact !== undefined && (artifact === null || typeof artifact !== "object" || Array.isArray(artifact))) {
      throw new Error("approvalArtifact must be the signed approval object");
    }
    const refId = input.refId?.trim() || `PARMANA-${crypto.randomUUID()}`;
    return this.governedRefund.refund({ ...input, refId });
  }
}
