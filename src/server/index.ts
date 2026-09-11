import http from "node:http";
import { PaytmHttpClient } from "../paytm/client.js";
import { PaytmRefundConnector } from "../paytm/refund.js";
import { ParmanaHttpClient } from "../parmana/client.js";
import { ParmanaRefundAuthorizer } from "../parmana/refund-authorizer.js";
import { GovernedPaytmRefundService } from "../governed-refund.js";
import { RefundAgent } from "../agent/refund-agent.js";

const config = loadConfig();
const parmana = new ParmanaHttpClient({ baseUrl: config.parmanaUrl, apiKey: config.parmanaApiKey, timeoutMs: config.timeoutMs });
const paytmClient = new PaytmHttpClient({ environment: config.paytmEnvironment, merchantId: config.paytmMerchantId, merchantKey: config.paytmMerchantKey, timeoutMs: config.timeoutMs });
const service = new GovernedPaytmRefundService(new ParmanaRefundAuthorizer(parmana, config.parmanaPrincipalId), new PaytmRefundConnector(paytmClient));
const agent = new RefundAgent(service);

export const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { status: "ok", service: "parmana-paytm-agent" });
    if (request.method === "POST" && request.url === "/agent/refunds") {
      if (!authorized(request.headers.authorization, config.agentApiKey)) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJson(request);
      const result = await agent.proposeRefund(body as Parameters<typeof agent.proposeRefund>[0]);
      return sendJson(response, result.decision === "DENIED" ? 403 : 200, result);
    }
    return sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "request failed" });
  }
});

if (process.env.NODE_ENV !== "test") server.listen(config.port, "0.0.0.0", () => console.log(`parmana-paytm-agent listening on ${config.port}`));

function loadConfig() {
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
  const port = Number(process.env.PORT ?? "3000");
  const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(port) || port <= 0) throw new Error("PORT must be a positive integer");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("REQUEST_TIMEOUT_MS must be a positive integer");
  const paytmEnvironment = (process.env.PAYTM_ENVIRONMENT ?? "staging").trim();
  if (paytmEnvironment !== "staging" && paytmEnvironment !== "production") throw new Error("PAYTM_ENVIRONMENT must be staging or production");
  return {
    port, timeoutMs,
    agentApiKey: required("AGENT_API_KEY"),
    parmanaUrl: required("PARMANA_API_URL"), parmanaApiKey: required("PARMANA_API_KEY"), parmanaPrincipalId: required("PARMANA_PRINCIPAL_ID"),
    paytmEnvironment, paytmMerchantId: required("PAYTM_MERCHANT_ID"), paytmMerchantKey: required("PAYTM_MERCHANT_KEY"),
  } as const;
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === expected;
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 64 * 1024) throw new Error("request body too large"); chunks.push(buffer); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
