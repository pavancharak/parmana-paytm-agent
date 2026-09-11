import { bindAuthorizedRefund } from "./parmana/authorization.js";
import { ParmanaRefundAuthorizer } from "./parmana/refund-authorizer.js";
import { PaytmRefundConnector } from "./paytm/refund.js";
import type { RefundResponse } from "./paytm/types.js";

export interface GovernedRefundRequest {
  orderId: string;
  txnId: string;
  refId: string;
  amount: string;
  reason?: string;
  signals: {
    refundEligible: boolean;
    managerApproved: boolean;
    fraudCheckPassed: boolean;
    maximumRefundAmount: number;
  };
}

export type GovernedRefundResult =
  | {
      decision: "DENIED";
      authorizationId: string;
      transactionId: string;
      reason: string;
    }
  | {
      decision: "APPROVED";
      authorizationId: string;
      transactionId: string;
      paytm: RefundResponse;
    };

/**
 * The only application path that may initiate a Paytm refund.
 * Parmana must approve the exact order, transaction and amount first.
 */
export class GovernedPaytmRefundService {
  constructor(
    private readonly authorizer: ParmanaRefundAuthorizer,
    private readonly paytm: PaytmRefundConnector,
  ) {}

  async refund(request: GovernedRefundRequest): Promise<GovernedRefundResult> {
    const authorization = await this.authorizer.authorizeRefund({
      orderId: request.orderId,
      txnId: request.txnId,
      amount: request.amount,
      signals: request.signals,
    });

    if (authorization.decision.decision === "DENIED") {
      return {
        decision: "DENIED",
        authorizationId: authorization.decision.authorizationId,
        transactionId: authorization.transactionId,
        reason: authorization.decision.reason,
      };
    }

    bindAuthorizedRefund(
      {
        orderId: authorization.orderId,
        txnId: authorization.txnId,
        amount: authorization.amount,
        authorizationId: authorization.decision.authorizationId,
      },
      {
        orderId: request.orderId,
        txnId: request.txnId,
        amount: request.amount,
      },
    );

    const paytm = await this.paytm.initiateRefund({
      orderId: request.orderId,
      txnId: request.txnId,
      refId: request.refId,
      amount: request.amount,
      ...(request.reason?.trim() ? { reason: request.reason } : {}),
    });

    return {
      decision: "APPROVED",
      authorizationId: authorization.decision.authorizationId,
      transactionId: authorization.transactionId,
      paytm,
    };
  }
}
