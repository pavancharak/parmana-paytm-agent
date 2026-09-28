import crypto from "node:crypto";
import { GovernedPaytmRefundService, type GovernedRefundRequest } from "../governed-refund.js";

/** Parmana's PAYTM_REFUND_REFERENCE_MAX_LENGTH and PAYTM_REFUND_REASON_MAX_LENGTH (G-71). */
const MAX_REF_ID_LENGTH = 128;
const MAX_REASON_LENGTH = 256;

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
    // Parmana's Paytm adapter enforces these limits only at release, after
    // approval, where a refusal reads as an unknown outcome; check first.
    if (refId.length > MAX_REF_ID_LENGTH) throw new Error(`refId must be at most ${MAX_REF_ID_LENGTH} characters`);
    if (input.reason !== undefined && input.reason.trim().length > MAX_REASON_LENGTH) throw new Error(`reason must be at most ${MAX_REASON_LENGTH} characters`);
    return this.governedRefund.refund({ ...input, refId });
  }
}
