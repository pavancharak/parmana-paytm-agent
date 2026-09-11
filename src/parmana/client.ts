export interface ParmanaClientConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface BusinessTransaction {
  businessTransactionId: string;
  metadata: Record<string, unknown>;
  authority: Record<string, unknown>;
  authorization: Record<string, unknown>;
  intent: Record<string, unknown>;
  policy: Record<string, unknown>;
  signals: Record<string, unknown>;
  status: "RECEIVED";
  createdAt: string;
}

/**
 * The real, verified /execute response shape (confirmed against the
 * live deployment, https://parmana-api-real.vercel.app -- NOT the
 * earlier {transaction, context, trustRecord} envelope this file used
 * to expect, which no real Parmana deployment has ever returned).
 *
 * APPROVED: HTTP 200, the full signed Execution Trust Record --
 * {trustRecordId, businessTransactionId, transaction, executions,
 * overrides, verifications, receipts, trustRecordHash, signature,
 * authorization: {payload: {authorizationId, ...}}, createdAt,
 * updatedAt}. `trustRecord` here is exactly that raw response body.
 *
 * DENIED: HTTP 403, {error, code: "POLICY_DENIED"} -- not an
 * exception; a normal, expected outcome this client returns as data,
 * mirroring exactly how ExecutionGate.enforce (the real Parmana
 * source) distinguishes a policy rejection from a genuine failure.
 */
export type ParmanaExecutionResult =
  | {
      readonly outcome: "APPROVED";
      readonly businessTransactionId: string;
      readonly authorizationId: string;
      readonly trustRecord: Record<string, unknown>;
    }
  | {
      readonly outcome: "DENIED";
      readonly businessTransactionId: string;
      readonly reason: string;
    };

export class ParmanaExecutionAmbiguousError extends Error {
  readonly status: number;
  readonly transactionId: string;

  constructor(status: number, transactionId: string, body: unknown) {
    super(
      `Parmana execution outcome is ambiguous (HTTP ${status}) for transaction ${transactionId}; reconcile the persisted transaction before retrying: ${safeJson(body)}`,
    );
    this.name = "ParmanaExecutionAmbiguousError";
    this.status = status;
    this.transactionId = transactionId;
  }
}

export class ParmanaHttpClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ParmanaClientConfig) {
    if (!config.baseUrl) throw new Error("PARMANA_API_URL is required");
    if (!config.apiKey) throw new Error("PARMANA_API_KEY is required");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("Parmana timeoutMs must be a positive integer");
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  async execute(transaction: BusinessTransaction): Promise<ParmanaExecutionResult> {
    const response = await this.request("/execute", { method: "POST", body: transaction });

    if (response.ok) {
      return parseApprovedResult(response.status, response.body, transaction.businessTransactionId);
    }

    // A clean policy denial is a definite, non-ambiguous outcome --
    // never thrown as an error. ExecutionGate.enforce (the real
    // Parmana source) always returns exactly this {error, code:
    // "POLICY_DENIED"} shape at HTTP 403 for a REJECT decision.
    if (response.status === 403 && isRecord(response.body) && response.body["code"] === "POLICY_DENIED") {
      return {
        outcome: "DENIED",
        businessTransactionId: transaction.businessTransactionId,
        reason: typeof response.body["error"] === "string" ? response.body["error"] : "Parmana policy rejected the refund",
      };
    }

    if (response.status === 409 || response.status >= 500) {
      throw new ParmanaExecutionAmbiguousError(
        response.status,
        transaction.businessTransactionId,
        response.body,
      );
    }

    throw new Error(`Parmana API HTTP ${response.status}: ${safeJson(response.body)}`);
  }

  /**
   * Durable recovery path. Parmana's Trust Record is the authoritative
   * persisted decision/evidence for a business transaction.
   */
  async getTrustRecord(businessTransactionId: string): Promise<Record<string, unknown> | null> {
    const encodedId = encodeURIComponent(businessTransactionId);
    const response = await this.request(`/trust-records/${encodedId}`, { method: "GET" });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Parmana trust-record API HTTP ${response.status}: ${safeJson(response.body)}`);
    }
    if (!isRecord(response.body)) {
      throw new Error("Parmana returned an invalid trust record response");
    }
    return response.body;
  }

  private async request(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ status: number; ok: boolean; body: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${this.config.apiKey}`,
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Parmana returned non-JSON response (HTTP ${response.status})`);
      }
      return { status: response.status, ok: response.ok, body };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Extracts the granted authorizationId from a real Execution Trust
 * Record: the signed top-level `authorization.payload.authorizationId`
 * (the actual authorization Parmana issued), falling back to the last
 * execution's `metadata.authorizationId` (also present on the real
 * response, and equal to the same value) if the primary field is
 * somehow absent.
 */
export function parseApprovedResult(status: number, value: unknown, expectedTransactionId: string): ParmanaExecutionResult {
  if (!isRecord(value)) throw new Error(`Parmana returned an invalid execution response (HTTP ${status})`);

  const transaction = value["transaction"];
  if (!isRecord(transaction) || transaction["businessTransactionId"] !== expectedTransactionId) {
    throw new Error("Parmana returned an execution response for a different business transaction");
  }

  const executions = Array.isArray(value["executions"]) ? value["executions"].filter(isRecord) : [];
  const lastExecution = executions.at(-1);
  const decision = lastExecution && isRecord(lastExecution["decision"]) ? lastExecution["decision"] : undefined;
  const outcome = decision ? String(decision["outcome"] ?? "") : "";

  if (outcome !== "APPROVED") {
    throw new Error(`Parmana returned HTTP ${status} with no APPROVED execution decision -- malformed response`);
  }

  const authorizationEnvelope = value["authorization"];
  const payload = isRecord(authorizationEnvelope) ? authorizationEnvelope["payload"] : undefined;
  const executionMetadata = lastExecution && isRecord(lastExecution["metadata"]) ? lastExecution["metadata"] : undefined;

  const authorizationId =
    (isRecord(payload) && typeof payload["authorizationId"] === "string" ? payload["authorizationId"] : undefined) ??
    (executionMetadata && typeof executionMetadata["authorizationId"] === "string" ? executionMetadata["authorizationId"] : undefined);

  if (!authorizationId) {
    throw new Error("Parmana APPROVED response did not contain an authorizationId");
  }

  return {
    outcome: "APPROVED",
    businessTransactionId: expectedTransactionId,
    authorizationId,
    trustRecord: value,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "<unserializable>"; }
}
