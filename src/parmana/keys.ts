import { createPublicKey, type KeyObject } from "node:crypto";

/**
 * Fetches Parmana's public key for one keyId, used to verify the
 * signature GatewayPaytmAdapter attaches to each POST
 * /connector/paytm-refund request (ADR-0009 Phase 2B, in
 * AgentLabsBuildathon).
 *
 * Deliberately unauthenticated: Parmana's own GET /keys/:keyId is
 * mounted ahead of its caller-auth middleware specifically so a third
 * party can fetch the key it needs to verify a signature without
 * already holding a Parmana-issued credential (see that route's own
 * doc comment, packages/api/src/routes/keys.ts in the Parmana repo).
 * No PARMANA_API_KEY is sent here.
 */
export async function fetchParmanaPublicKey(
  baseUrl: string,
  keyId: string,
  timeoutMs: number,
): Promise<KeyObject> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/keys/${encodeURIComponent(keyId)}`,
      { method: "GET", signal: controller.signal },
    );

    if (!response.ok) {
      throw new Error(
        `Parmana key discovery HTTP ${response.status} for keyId "${keyId}"`,
      );
    }

    const body: unknown = await response.json();

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).pem !== "string"
    ) {
      throw new Error(
        `Parmana key discovery returned an invalid response for keyId "${keyId}"`,
      );
    }

    return createPublicKey((body as { pem: string }).pem);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Parmana key discovery for keyId "${keyId}" timed out after ${timeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
