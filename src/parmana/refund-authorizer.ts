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
    // The real, deployed Parmana capability id (namespaced,
    // "paytm:refund") -- NOT the hyphenated "paytm-refund" wire
    // action the connector service's own POST /connector/paytm-refund
    // body uses (see server/handler.ts's own check). Those are two
    // unrelated contracts: this one is intent.action sent to
    // Parmana's /execute; that one is the connector-service envelope
    // GatewayPaytmAdapter (Parmana's own execution gateway) builds
    // after Parmana has already decided. Confirmed against the real
    // deployment: only "paytm:refund" has a canonical capability/
    // policy binding and a registered connector.
    private readonly action = "paytm:refund",
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
        // The real, deployed paytm:refund capability's deny-by-default
        // parameter allowlist is exactly {orderId, transactionId,
        // amount, refundReason} (packages/connector-paytm's
        // PAYTM_ALLOWED_REFUND_PARAMETERS in the Parmana repo) --
        // NOT txnId or refId. GatewayPaytmAdapter (Parmana's own
        // execution gateway) derives refId itself, deterministically,
        // from (orderId, transactionId) -- sending our own here would
        // be silently ignored at best and refused outright at worst
        // (confirmed: refused, HTTP 500 "unsupported refund
        // parameters" against the real deployment). Parmana's
        // `transactionId` is this integration's own `txnId`.
        parameters: {
          amount: Number(amount),
          orderId: input.orderId,
          transactionId: input.txnId,
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
      decision:
        raw.outcome === "APPROVED"
          ? { decision: "APPROVED", authorizationId: raw.authorizationId }
          : { decision: "DENIED", authorizationId: "", reason: raw.reason },
      transactionId: raw.businessTransactionId,
      orderId,
      txnId,
      amount,
      raw,
    };
  }
}

/**
 * Recovery path for an ambiguous execute() outcome (HTTP 409/5xx):
 * re-derives the same ParmanaExecutionResult shape execute() itself
 * returns from the durably persisted Trust Record, so callers never
 * need a second code path to interpret a recovered decision.
 */
function parseRecoveredTrustRecord(
  value: Record<string, unknown>,
  expectedTransactionId: string,
): ParmanaExecutionResult {
  return parseApprovedOrDeniedFromTrustRecord(value, expectedTransactionId);
}

function parseApprovedOrDeniedFromTrustRecord(
  value: Record<string, unknown>,
  expectedTransactionId: string,
): ParmanaExecutionResult {
  const transaction = value["transaction"];
  if (!isRecord(transaction) || transaction["businessTransactionId"] !== expectedTransactionId) {
    throw new Error("Parmana recovery returned a mismatched business transaction");
  }

  const executions = Array.isArray(value["executions"]) ? value["executions"].filter(isRecord) : [];
  const lastExecution = executions.at(-1);

  if (!lastExecution) throw new Error("Parmana recovery returned no persisted decision");

  const decision = isRecord(lastExecution["decision"]) ? lastExecution["decision"] : undefined;

  if (!decision) throw new Error("Parmana recovery returned no persisted decision");

  const outcome = String(decision["outcome"] ?? "");

  if (outcome === "APPROVED") {
    const authorizationEnvelope = value["authorization"];
    const payload = isRecord(authorizationEnvelope) ? authorizationEnvelope["payload"] : undefined;
    const executionMetadata = isRecord(lastExecution["metadata"]) ? lastExecution["metadata"] : undefined;
    const authorizationId =
      (isRecord(payload) && typeof payload["authorizationId"] === "string" ? payload["authorizationId"] : undefined) ??
      (executionMetadata && typeof executionMetadata["authorizationId"] === "string" ? executionMetadata["authorizationId"] : undefined);

    if (!authorizationId) throw new Error("Parmana recovery returned an APPROVED decision with no authorizationId");

    return { outcome: "APPROVED", businessTransactionId: expectedTransactionId, authorizationId, trustRecord: value };
  }

  return {
    outcome: "DENIED",
    businessTransactionId: expectedTransactionId,
    reason: typeof decision["reason"] === "string" ? decision["reason"] : "Parmana policy rejected the refund",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
