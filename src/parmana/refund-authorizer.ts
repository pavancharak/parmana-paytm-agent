import crypto from "node:crypto";
import type { ParmanaExecutionResult } from "./client.js";
import { ParmanaExecutionAmbiguousError, ParmanaHttpClient } from "./client.js";
import type { AuthorizationDecision } from "./authorization.js";

export interface RefundAuthorizationInput {
  orderId: string;
  txnId: string;
  amount: string;
  refId: string;
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

const REFUND_TRANSACTION_NAMESPACE = "parmana-paytm-refund:v1";

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
    const refId = requireNonEmpty(input.refId, "refId");
    const transactionId = deterministicRefundTransactionId(refId);
    const authorityId = deterministicUuid(`${transactionId}:authority`);
    const authorizationId = deterministicUuid(`${transactionId}:authorization`);
    const intentId = deterministicUuid(`${transactionId}:intent`);
    const issuedAt = new Date().toISOString();

    const transaction = {
      businessTransactionId: transactionId,
      metadata: {
        businessTransactionId: transactionId,
        integration: "parmana-paytm-agent",
        refundRefId: refId,
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
          refId,
        },
        createdAt: issuedAt,
      },
      policy: { name: "customer-refund", version: "1.0.0", schemaVersion: "1.0.0" },
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

    try {
      const raw = await this.client.execute(transaction);
      return this.toAuthorization(raw, input.orderId, input.txnId, amount);
    } catch (error) {
      if (!(error instanceof ParmanaExecutionAmbiguousError)) throw error;

      const persisted = await this.client.getTrustRecord(transactionId);
      if (!persisted) throw error;

      const recovered = parseRecoveredTrustRecord(persisted, transactionId);
      return this.toAuthorization(recovered, input.orderId, input.txnId, amount);
    }
  }

  private toAuthorization(
    raw: ParmanaExecutionResult,
    orderId: string,
    txnId: string,
    amount: string,
  ): RefundAuthorization {
    return {
      decision: extractDecision(raw),
      transactionId: raw.transaction.businessTransactionId,
      orderId,
      txnId,
      amount,
      raw,
    };
  }
}

function parseRecoveredTrustRecord(
  value: Record<string, unknown>,
  expectedTransactionId: string,
): ParmanaExecutionResult {
  const transaction = value["transaction"];
  if (!isRecord(transaction) || transaction["businessTransactionId"] !== expectedTransactionId) {
    throw new Error("Parmana recovery returned a mismatched business transaction");
  }

  const executions = Array.isArray(value["executions"]) ? value["executions"] : [];
  const execution = executions.at(-1);
  const decision = isRecord(execution) && isRecord(execution["decision"])
    ? execution["decision"]
    : undefined;

  if (!decision) throw new Error("Parmana recovery returned no persisted decision");

  return {
    transaction: transaction as unknown as ParmanaExecutionResult["transaction"],
    context: { decision },
    trustRecord: value,
  };
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeAmount(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("refund amount must be positive");
  return numeric.toFixed(2);
}

export function deterministicRefundTransactionId(refId: string): string {
  return deterministicUuid(`${REFUND_TRANSACTION_NAMESPACE}:${requireNonEmpty(refId, "refId")}`);
}

function deterministicUuid(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) throw new Error("unable to construct deterministic UUID");
  bytes[6] = (byte6 & 0x0f) | 0x40;
  bytes[8] = (byte8 & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extractDecision(raw: ParmanaExecutionResult): AuthorizationDecision {
  const candidates = [
    raw.context["decision"],
    raw.context["policyDecision"],
    raw.trustRecord["decision"],
    raw.trustRecord["outcome"],
    ...extractExecutionDecisions(raw.trustRecord),
  ];

  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const outcome = String(candidate["outcome"] ?? candidate["decision"] ?? candidate["action"] ?? "").toUpperCase();
    if (outcome === "APPROVE" || outcome === "APPROVED") {
      const authorizationId = String(candidate["authorizationId"] ?? raw.transaction.authorization["authorizationId"] ?? "");
      if (!authorizationId) throw new Error("Parmana approval did not contain authorizationId");
      return { decision: "APPROVED", authorizationId };
    }
    if (outcome === "REJECT" || outcome === "REJECTED" || outcome === "DENY" || outcome === "DENIED") {
      const authorizationId = String(candidate["authorizationId"] ?? raw.transaction.authorization["authorizationId"] ?? "");
      return { decision: "DENIED", authorizationId, reason: String(candidate["reason"] ?? "Parmana policy rejected the refund") };
    }
  }
  throw new Error("Unable to determine Parmana authorization outcome from persisted evidence");
}

function extractExecutionDecisions(record: Record<string, unknown>): Record<string, unknown>[] {
  const executions = Array.isArray(record["executions"]) ? record["executions"] : [];
  return executions
    .filter(isRecord)
    .map((execution) => execution["decision"])
    .filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
