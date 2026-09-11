import crypto from "node:crypto";
import type { ParmanaExecutionResult } from "./client.js";
import { ParmanaHttpClient } from "./client.js";
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

/**
 * Stable namespace for the Paytm refund authorization identity.
 *
 * A Paytm refId represents one logical refund. The same refId must therefore
 * map to the same Parmana business transaction so duplicate submissions cannot
 * silently create a second authorization. The UUID is deliberately shaped as
 * RFC-4122 version 4 because Parmana's admission contract accepts UUIDs with
 * versions 1-5; the value itself is deterministically derived from SHA-256.
 */
const REFUND_TRANSACTION_NAMESPACE =
  "parmana-paytm-refund:v1";

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

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeAmount(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("refund amount must be positive");
  }
  return numeric.toFixed(2);
}

export function deterministicRefundTransactionId(refId: string): string {
  return deterministicUuid(`${REFUND_TRANSACTION_NAMESPACE}:${requireNonEmpty(refId, "refId")}`);
}

function deterministicUuid(seed: string): string {
  const digest = crypto.createHash("sha256").update(seed, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));

  // RFC-4122 variant + version 4 shape. This remains a valid UUID while the
  // underlying value is deterministic rather than random.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
