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

export interface ParmanaExecutionResult {
  transaction: BusinessTransaction;
  context: Record<string, unknown>;
  trustRecord: Record<string, unknown>;
}

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

    if (!response.ok) {
      if (response.status === 409 || response.status >= 500) {
        throw new ParmanaExecutionAmbiguousError(
          response.status,
          transaction.businessTransactionId,
          response.body,
        );
      }
      throw new Error(`Parmana API HTTP ${response.status}: ${safeJson(response.body)}`);
    }

    return parseExecutionResult(response.status, response.body);
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

function parseExecutionResult(status: number, value: unknown): ParmanaExecutionResult {
  if (!isRecord(value)) throw new Error(`Parmana returned an invalid execution response (HTTP ${status})`);
  if (!isRecord(value["transaction"]) || !isRecord(value["context"]) || !isRecord(value["trustRecord"])) {
    throw new Error("Parmana returned an incomplete execution response");
  }
  return value as unknown as ParmanaExecutionResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "<unserializable>"; }
}
