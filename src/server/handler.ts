import type { IncomingMessage, ServerResponse } from "node:http";
import { PaytmHttpClient } from "../paytm/client.js";
import { PaytmRefundConnector } from "../paytm/refund.js";
import { ParmanaHttpClient } from "../parmana/client.js";
import { ParmanaRefundAuthorizer } from "../parmana/refund-authorizer.js";
import { GovernedPaytmRefundService } from "../governed-refund.js";
import { RefundAgent } from "../agent/refund-agent.js";

/**
 * The request handler itself, extracted from a listening http.Server so
 * it can be reused by two entrypoints with the same request-handling
 * behavior:
 *   - src/server/index.ts: a plain Node http.Server (`npm start`, local
 *     development, and anywhere else that needs a long-lived listener).
 *   - api/index.ts: Vercel's Node.js Function runtime, which invokes
 *     this handler per-request and never calls .listen() itself.
 * Config loading and service construction happen once, at module load
 * (module-scope, below) -- unchanged from the original single-file
 * version -- so both entrypoints share exactly one configuration read
 * and one set of constructed clients, not a duplicate per entrypoint.
 */

export const config = loadConfig();
const parmana = new ParmanaHttpClient({ baseUrl: config.parmanaUrl, apiKey: config.parmanaApiKey, timeoutMs: config.timeoutMs });
const paytmClient = new PaytmHttpClient({ environment: config.paytmEnvironment, merchantId: config.paytmMerchantId, merchantKey: config.paytmMerchantKey, timeoutMs: config.timeoutMs });
const paytm = new PaytmRefundConnector(paytmClient);
const service = new GovernedPaytmRefundService(new ParmanaRefundAuthorizer(parmana, config.parmanaPrincipalId), paytm);
const agent = new RefundAgent(service);

export async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { status: "ok", service: "parmana-paytm-agent" });

    if (request.method === "POST" && request.url === "/agent/refunds") {
      if (!authorized(request.headers.authorization, config.agentApiKey)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const result = await agent.proposeRefund(body as Parameters<typeof agent.proposeRefund>[0]);
      return sendJson(response, result.decision === "DENIED" ? 403 : 200, result);
    }

    if (request.method === "POST" && request.url === "/connector/paytm-refund") {
      if (!authorized(request.headers.authorization, config.connectorSharedSecret)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const result = await executeAuthorizedConnectorRequest(body, paytm);
      return sendJson(response, 200, result);
    }

    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "request failed" });
  }
}

function loadConfig() {
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
  const port = Number(process.env.PORT ?? "3000");
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("REQUEST_TIMEOUT_MS must be a positive integer");
  const paytmEnvironment = (process.env.PAYTM_ENVIRONMENT ?? "staging").trim();
  if (paytmEnvironment !== "staging" && paytmEnvironment !== "production") throw new Error("PAYTM_ENVIRONMENT must be staging or production");
  return {
    port,
    timeoutMs,
    agentApiKey: required("AGENT_API_KEY"),
    connectorSharedSecret: required("PAYTM_CONNECTOR_SHARED_SECRET"),
    parmanaUrl: required("PARMANA_API_URL"),
    parmanaApiKey: required("PARMANA_API_KEY"),
    parmanaPrincipalId: required("PARMANA_PRINCIPAL_ID"),
    paytmEnvironment,
    paytmMerchantId: required("PAYTM_MERCHANT_ID"),
    paytmMerchantKey: required("PAYTM_MERCHANT_KEY"),
  } as const;
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === expected;
}

async function executeAuthorizedConnectorRequest(body: Record<string, unknown>, connector: PaytmRefundConnector): Promise<Record<string, unknown>> {
  const transaction = asRecord(body.transaction, "transaction");
  const intent = asRecord(transaction.intent, "transaction.intent");
  const authorization = asRecord(body.authorization, "authorization");
  const payload = asRecord(authorization.payload, "authorization.payload");
  const parameters = asRecord(intent.parameters, "transaction.intent.parameters");

  const action = String(intent.action ?? "");
  if (action !== "paytm-refund") throw new Error("unsupported connector action");

  const transactionId = String(transaction.businessTransactionId ?? "");
  if (!transactionId || payload.businessTransactionId !== transactionId) throw new Error("authorization is not bound to the business transaction");
  if (payload.grantedCapability !== undefined && payload.grantedCapability !== action) throw new Error("authorization capability does not match connector action");

  const orderId = requireParameter(parameters, "orderId");
  const txnId = requireParameter(parameters, "txnId");
  const refId = requireParameter(parameters, "refId");
  const amount = requireParameter(parameters, "amount");
  const paytmResult = await connector.initiateRefund({ orderId, txnId, refId, amount });
  const resultStatus = String(paytmResult.body.resultStatus ?? "").toUpperCase();
  const success = resultStatus === "S" || resultStatus === "SUCCESS";

  return {
    businessTransactionId: transactionId,
    action,
    target: String(intent.target ?? orderId),
    parameters: { orderId, txnId, refId, amount },
    success,
    executedAt: new Date().toISOString(),
    metadata: { provider: "paytm", resultStatus: resultStatus || "UNKNOWN", resultCode: paytmResult.body.resultCode ?? null },
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requireParameter(parameters: Record<string, unknown>, field: string): string {
  const value = parameters[field];
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${field} is required`);
  return String(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 64 * 1024) throw new Error("request body too large"); chunks.push(buffer); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
