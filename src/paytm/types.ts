export type PaytmEnvironment = "staging" | "production";

export interface PaytmConfig {
  environment: PaytmEnvironment;
  merchantId: string;
  merchantKey: string;
  clientId?: string;
  timeoutMs: number;
}

export interface RefundRequest {
  orderId: string;
  txnId: string;
  refId: string;
  amount: string;
  reason?: string;
}

export interface RefundResponse {
  body: Record<string, unknown>;
  head: Record<string, unknown>;
  raw: unknown;
}

export interface RefundStatusRequest {
  orderId: string;
  refId?: string;
}

export interface RefundStatusResponse {
  body: Record<string, unknown>;
  head: Record<string, unknown>;
  raw: unknown;
}

export interface PaytmTransport {
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
}
