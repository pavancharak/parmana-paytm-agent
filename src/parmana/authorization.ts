export type AuthorizationDecision =
  | { decision: "APPROVED"; authorizationId: string }
  | { decision: "DENIED"; authorizationId: string; reason: string };

export interface AuthorizedRefund {
  orderId: string;
  txnId: string;
  amount: string;
  authorizationId: string;
}

export interface ParmanaRefundAuthorizer {
  authorizeRefund(input: {
    orderId: string;
    txnId: string;
    amount: string;
    signals: Record<string, unknown>;
  }): Promise<AuthorizationDecision>;
}

/**
 * Binds the exact parameters evaluated by Parmana to the eventual side effect.
 * A changed order, transaction or amount cannot reuse an earlier approval.
 */
export function bindAuthorizedRefund(
  approved: AuthorizedRefund,
  requested: { orderId: string; txnId: string; amount: string },
): void {
  if (approved.orderId !== requested.orderId) throw new Error("authorized orderId mismatch");
  if (approved.txnId !== requested.txnId) throw new Error("authorized txnId mismatch");
  if (Number(approved.amount).toFixed(2) !== Number(requested.amount).toFixed(2)) {
    throw new Error("authorized refund amount mismatch");
  }
}
