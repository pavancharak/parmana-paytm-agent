/**
 * Build-time required-environment-variable check (INC-11,
 * AgentLabsBuildathon's 04-INCIDENTS-LOG.md).
 *
 * Wired as this package's `vercel-build` script -- Vercel's own
 * recognized script name, run during the build with the same
 * environment variables the resulting deployment will have. Importing
 * src/server/handler.ts triggers its module-scope
 * `export const config = loadConfig();`, which throws with a clear,
 * named error if any required variable (AGENT_API_KEY,
 * PAYTM_CONNECTOR_SHARED_SECRET, PARMANA_API_URL, PARMANA_API_KEY,
 * PARMANA_PRINCIPAL_ID, PAYTM_MERCHANT_ID, PAYTM_MERCHANT_KEY,
 * DATABASE_URL) is missing -- see loadConfig()'s own required() calls
 * for the exact, current list; this script deliberately does not
 * duplicate that list here, so it can never drift out of sync with
 * what the code actually requires.
 *
 * A thrown error here fails the Vercel *build*, not the first live
 * request: Vercel does not promote a failed build to production, so
 * the previous working deployment keeps serving instead of a new,
 * broken one going live. This is the fix for INC-11, where
 * DATABASE_URL became required but wasn't yet configured in the
 * target Vercel project -- the bad deploy went live and crashed on
 * every real request until someone noticed and fixed it manually.
 *
 * No network access required: handler.ts's module scope only
 * constructs plain client objects (ParmanaHttpClient,
 * PaytmHttpClient, PaytmRefundConnector, GovernedPaytmRefundService,
 * RefundAgent) -- none of them make a request in their constructor --
 * and audit.ts's Postgres pool is created lazily, on first write, not
 * at import time. This check only proves configuration is present,
 * never that DATABASE_URL/PARMANA_API_URL actually point at something
 * reachable.
 */

async function main(): Promise<void> {
  await import("../src/server/handler.js");

  console.log(
    "verify-required-env: all required environment variables are present.",
  );
}

main().catch((error: unknown) => {
  console.error("");
  console.error(
    "verify-required-env: a required environment variable is missing -- failing the build",
  );
  console.error(
    "so the previous working deployment keeps serving instead of this one going live broken.",
  );
  console.error("");
  console.error(error instanceof Error ? error.message : error);
  console.error("");
  process.exit(1);
});
