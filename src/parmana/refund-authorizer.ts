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
  /**
   * A manager's signed approval, forwarded unchanged. Parmana verifies it
   * (issuer, signature, expiry, bound to this orderId and amount) and
   * uses it once; this service never inspects its contents.
   */
  approvalArtifact?: Record<string, unknown>;
  /** Sent to Paytm as the refund comment, through Parmana's connector call. */
  reason?: string;
}

/**
 * What Paytm reported for the refund Parmana released, read from the
 * execution evidence in the signed Trust Record. Parmana releases an
 * approved refund to its Paytm connector inside POST /execute, so this is
 * the one and only Paytm call for the refund.
 */
export interface RefundExecution {
  success: boolean;
  refId?: string;
  resultStatus?: string;
  resultCode?: string;
}

export interface RefundAuthorization {
  decision: AuthorizationDecision;
  transactionId: string;
  orderId: string;
  txnId: string;
  amount: string;
  /** Present when the decision is APPROVED. */
  execution?: RefundExecution;
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
    const policy = await this.client.getPolicyInEffect(this.action);

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
        // amount, refundReason, refundReference} (packages/connector-paytm's
        // PAYTM_ALLOWED_REFUND_PARAMETERS in the Parmana repo) --
        // NOT txnId or refId. GatewayPaytmAdapter (Parmana's own
        // execution gateway) derives the Paytm refId itself; any other
        // name is refused ("unsupported refund parameters"), so this
        // service needs a Parmana deploy that includes refundReference
        // (G-71) before this one. Parmana's `transactionId` is this
        // integration's own `txnId`.
        parameters: {
          amount: Number(amount),
          orderId: input.orderId,
          transactionId: input.txnId,
          // G-71 (Parmana): this refund's own id. Parmana derives the
          // Paytm refId from (orderId, transactionId, refundReference),
          // so a retry with the same refId keeps one Paytm refId and a
          // separate refund of the same transaction gets another.
          refundReference: refId,
          ...(input.reason?.trim() ? { refundReason: input.reason.trim() } : {}),
        },
        createdAt: issuedAt,
      },
      // Never written into this code: Parmana enforces the version most
      // recently approved, so it is read before every refund.
      policy: { name: policy.name, version: policy.version, schemaVersion: policy.schemaVersion },
      signals: {
        refundEligible: input.signals.refundEligible,
        // A signed approval is what makes managerApproved true; Parmana
        // refuses managerApproved true without one it can verify.
        managerApproved: input.approvalArtifact !== undefined || input.signals.managerApproved,
        fraudCheckPassed: input.signals.fraudCheckPassed,
        refundAmount: Number(amount),
        maximumRefundAmount: input.signals.maximumRefundAmount,
        ...(input.approvalArtifact !== undefined ? { approvalArtifact: input.approvalArtifact } : {}),
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
      ...(raw.outcome === "APPROVED" ? { execution: readRefundExecution(raw.trustRecord) } : {}),
      raw,
    };
  }
}

/**
 * Reads what Paytm reported from the last execution's evidence
 * ({success, attributes: {refId, resultStatus, resultCode, ...}}, built
 * by Parmana from its Paytm connector's result). An APPROVED record with
 * no evidence means the outcome is unknown: this throws so the caller
 * reconciles, and never falls back to calling Paytm itself.
 */
export function readRefundExecution(trustRecord: Record<string, unknown>): RefundExecution {
  const executions = Array.isArray(trustRecord["executions"]) ? trustRecord["executions"].filter(isRecord) : [];
  const evidence = executions.at(-1)?.["evidence"];

  if (!isRecord(evidence) || typeof evidence["success"] !== "boolean") {
    throw new Error("Parmana approved the refund but its Trust Record has no execution evidence; the Paytm outcome is unknown, reconcile before retrying");
  }

  const attributes = isRecord(evidence["attributes"]) ? evidence["attributes"] : {};
  const execution: RefundExecution = { success: evidence["success"] };
  if (typeof attributes["refId"] === "string") execution.refId = attributes["refId"];
  if (typeof attributes["resultStatus"] === "string") execution.resultStatus = attributes["resultStatus"];
  if (typeof attributes["resultCode"] === "string") execution.resultCode = attributes["resultCode"];
  return execution;
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
