import { Pool } from "pg";

/**
 * Durable execution-audit trail for this service's own request path
 * (GAP-3, AgentLabsBuildathon repo's GAPS.md 2026-09-14). Before this,
 * executeAuthorizedConnectorRequest (src/server/handler.ts) logged
 * nothing at all -- not even to the console -- so neither a successful
 * refund nor a rejected one left any record on this side of the trust
 * boundary. Every rejection threw a plain Error, caught generically by
 * the request handler and returned as an HTTP error with no trace kept
 * anywhere.
 *
 * Writes to the SAME execution_audit_events table
 * AgentLabsBuildathon's own SupabaseExecutionAuditSink writes to (see
 * that class's own doc comment, "Shared table, two writers") -- not a
 * separate table -- so a regulator/operator query by
 * businessTransactionId retrieves one refund's complete story across
 * both services, not two disconnected half-records. businessTransactionId
 * is deliberately the correlation key, not authorizationId: Parmana's own
 * authorization identity is never forwarded across this trust boundary
 * (see GatewayPaytmAdapter's wire contract in the AgentLabsBuildathon
 * repo) -- this service only ever sees businessTransactionId, orderId,
 * txnId, and its own re-signed authorization envelope. authorizationId
 * and sessionId columns are NOT NULL on that table, so this writer uses
 * refId (deterministic per orderId+txnId, stable across idempotent
 * retries) as authorizationId, and a fresh id per HTTP call as
 * sessionId -- so repeated attempts at the same refId are visible as
 * distinct rows under one authorization_id, the closest honest analog
 * this service has to Parmana's own session concept.
 *
 * Deliberately unsigned and unchained (signature_json/chain_hash/
 * chain_position are NULL on every row this writes): this service holds
 * Parmana's PUBLIC key only, to verify, never a private key to sign
 * with, and has no Ed25519 keypair of its own. See the migration that
 * relaxed those columns to nullable
 * (20260914130000_add_business_transaction_correlation_to_execution_
 * audit_events.sql) for why that asymmetry is an acceptable, deliberate
 * trust-boundary choice rather than a gap of its own: a compromised
 * instance of this service could already forge real Paytm calls with
 * the credentials it legitimately holds, so cryptographic
 * non-repudiation of its own log entries would not raise the actual
 * trust bar -- durability is what this table adds here, not proof.
 *
 * Fails closed the same way loadConfig()'s required() does for every
 * other setting this service refuses to start without: DATABASE_URL is
 * required, checked at module load, not discovered as a surprise on the
 * first audit write.
 */

const INSERT_EXECUTION_AUDIT_EVENT_SQL = `
  INSERT INTO execution_audit_events
    (type, occurred_at, connector_id, authorization_id, session_id, action, reason, business_transaction_id)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8)
`;

export type PaytmAgentAuditEventType =
  | "authorization.verified"
  | "execution.completed"
  | "execution.rejected";

export interface PaytmAgentAuditEvent {
  readonly type: PaytmAgentAuditEventType;
  readonly refId: string;
  readonly sessionId: string;
  readonly businessTransactionId: string;
  readonly action: string;
  readonly reason?: string;
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool === undefined) {
    const databaseUrl = process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required for the execution-audit trail (GAP-3). " +
          "Refusing to run with no durable record of what this service " +
          "verifies and executes.",
      );
    }

    pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  return pool;
}

/**
 * Records one execution-audit event. Failure semantics deliberately
 * match ExecutionControlService.execute()'s own on the Parmana side: an
 * unguarded write, so a database outage fails the request rather than
 * silently executing (or rejecting) a real Paytm refund with no record
 * of it. Call sites in handler.ts do not, and must not, swallow a
 * rejection from this function.
 */
export async function recordPaytmAgentAuditEvent(
  event: PaytmAgentAuditEvent,
): Promise<void> {
  await getPool().query(INSERT_EXECUTION_AUDIT_EVENT_SQL, [
    event.type,
    new Date().toISOString(),
    "paytm",
    event.refId,
    event.sessionId,
    event.action,
    event.reason ?? null,
    event.businessTransactionId,
  ]);
}
