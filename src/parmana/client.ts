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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(transaction),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Parmana returned non-JSON response (HTTP ${response.status})`);
      }

      if (!response.ok) {
        throw new Error(`Parmana API HTTP ${response.status}: ${safeJson(parsed)}`);
      }

      if (!isRecord(parsed)) {
        throw new Error("Parmana returned an invalid execution response");
      }

      return parsed as unknown as ParmanaExecutionResult;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}
