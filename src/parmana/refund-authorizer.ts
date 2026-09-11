import crypto from "node:crypto";
import type { ParmanaExecutionResult } from "./client.js";
import { ParmanaHttpClient } from "./client.js";
import type { AuthorizationDecision } from "./authorization.js";

export interface RefundAuthorizationInput {
  orderId: string;
  txnId: string;
  amount: string;
  signals: {
    refundEligible: boolean;
    managerApproved: boolean;
    fraudCheckPassed: boolean;
    maximumRefundAmount: number;
  };
}

export interface RefundAuthorization {
  decision: AuthorizationDecision;
  transactionId: string;
  orderId: string;
  txnId: string;
  amount: string;
  raw: ParmanaExecutionResult;
}

export class ParmanaRefundAuthorizer {
  constructor(
    private readonly client: ParmanaHttpClient,
    private readonly principalId: string,
    private readonly action = "paytm-refund",
  ) {
    if (!principalId.trim()) throw new Error("Parmana principalId is required");
  }

  async authorizeRefund(input: RefundAuthorizationInput): Promise<RefundAuthorization> {
    const amount = normalizeAmount(input.amount);
    const transactionId = crypto.randomUUID();
    const authorityId = crypto.randomUUID();
    const authorizationId = crypto.randomUUID();
    const intentId = crypto.randomUUID();
    const issuedAt = new Date().toISOString();

    const transaction = {
      businessTransactionId: transactionId,
      metadata: {
        businessTransactionId: transactionId,
        integration: "parmana-paytm-agent",
      },
      authority: {
        authorityId,
        authorityType: "SERVICE",
        principalId: this.principalId,
        issuedAt,
      },
      authorization: {
        authorizationId,
        authorityId,
        purpose: "Authorize Paytm customer refund",
        issuedAt,
      },
      intent: {
        intentId,
        authorizationId,
        action: this.action,
        target: input.orderId,
        parameters: {
          amount: Number(amount),
          orderId: input.orderId,
          txnId: input.txnId,
        },
        createdAt: issuedAt,
      },
      policy: {
        name: "customer-refund",
        version: "1.0.0",
        schemaVersion: "1.0.0",
      },
      signals: {
        refundEligible: input.signals.refundEligible,
        managerApproved: input.signals.managerApproved,
        fraudCheckPassed: input.signals.fraudCheckPassed,
        refundAmount: Number(amount),
        maximumRefundAmount: input.signals.maximumRefundAmount,
      },
      status: "RECEIVED" as const,
      createdAt: issuedAt,
    };

    const raw = await this.client.execute(transaction);
    const decision = extractDecision(raw);

    return {
      decision,
      transactionId,
      orderId: input.orderId,
      txnId: input.txnId,
      amount,
      raw,
    };
  }
}

function normalizeAmount(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("refund amount must be positive");
  }
  return numeric.toFixed(2);
}

function extractDecision(raw: ParmanaExecutionResult): AuthorizationDecision {
  const context = raw.context;
  const trustRecord = raw.trustRecord;
  const candidates = [
    context["decision"],
    context["policyDecision"],
    trustRecord["decision"],
    trustRecord["outcome"],
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const outcome = String(record["outcome"] ?? record["decision"] ?? record["action"] ?? "").toUpperCase();
    if (outcome === "APPROVE" || outcome === "APPROVED") {
      const authorizationId = String(record["authorizationId"] ?? record["id"] ?? "");
      if (!authorizationId) throw new Error("Parmana approval did not contain authorizationId");
      return { decision: "APPROVED", authorizationId };
    }
    if (outcome === "REJECT" || outcome === "REJECTED" || outcome === "DENY" || outcome === "DENIED") {
      const authorizationId = String(record["authorizationId"] ?? record["id"] ?? raw.transaction.authorization["authorizationId"] ?? "");
      return {
        decision: "DENIED",
        authorizationId,
        reason: String(record["reason"] ?? "Parmana policy rejected the refund"),
      };
    }
  }

  throw new Error("Unable to determine Parmana authorization outcome");
}
