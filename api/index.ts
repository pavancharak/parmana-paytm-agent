import { requestHandler } from "../src/server/handler.js";

/**
 * Vercel Node.js Function entrypoint. Reuses the exact same request
 * handler the local http.Server (src/server/index.ts) uses -- no
 * behavior fork between local dev and this deployment. Never calls
 * .listen(): Vercel invokes this handler per-request itself.
 *
 * vercel.json rewrites every path to this one function so the deployed
 * API keeps the same route shape (/health, /agent/refunds,
 * /connector/paytm-refund) documented in openapi/paytm-agent.yaml and
 * used by local development, rather than requiring an /api prefix.
 */
export default requestHandler;
