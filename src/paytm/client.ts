import { assertMerchantKey, generateChecksum } from "./auth.js";
import type { PaytmConfig, PaytmTransport } from "./types.js";

const BASE_URLS = {
  production: "https://secure.paytmpayments.com",
  staging: "https://securestage.paytmpayments.com",
} as const;

export class PaytmHttpClient implements PaytmTransport {
  private readonly baseUrl: string;

  constructor(private readonly config: PaytmConfig) {
    if (!config.merchantId) throw new Error("PAYTM_MERCHANT_ID is required");
    assertMerchantKey(config.merchantKey);
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }
    this.baseUrl = BASE_URLS[config.environment];
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const signedBody = { ...body, mid: this.config.merchantId };
    const signature = generateChecksum(JSON.stringify(signedBody), this.config.merchantKey);
    const payload = {
      body: signedBody,
      head: { tokenType: "AES", signature, channelId: "WEB" },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${normalizedPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Paytm returned non-JSON response (HTTP ${response.status})`);
      }

      if (!response.ok) {
        throw new Error(`Paytm API HTTP ${response.status}: ${JSON.stringify(parsed)}`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
