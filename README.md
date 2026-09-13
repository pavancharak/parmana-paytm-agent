# Parmana Paytm Agent

Production-grade Paytm execution connector governed by Parmana authorization.

## Execution boundary

```text
AI Agent
   ↓
Intent / RefundRequest
   ↓
Parmana Authorization
   ├── DENIED → Evidence → STOP
   └── APPROVED
          ↓
     Paytm Connector
          ↓
     Paytm Refund API
          ↓
     Status / Webhook Verification
          ↓
     Execution Evidence
```

The connector is not an authorization layer. Paytm side effects are reachable only after a successful Parmana authorization decision, with the authorized transaction parameters bound to the execution request.

## Why this architecture (out-of-process connector, non-AI gatekeeper)

This service exists as a **separate deployment** from Parmana, rather than Parmana calling Paytm's API in-process the way it calls HubSpot's or GitHub's (see `docs/connectors/PAYTM_CONNECTOR.md` in the AgentLabsBuildathon repo for that comparison). Both this service and Parmana are deliberately **deterministic, non-AI code** on the execution path — an AI agent may *propose* a refund; nothing that decides whether it happens or actually moves money is an LLM.

### Benefits

- **No AI judgment in the execution path.** `RefundAgent`/`GovernedPaytmRefundService` are plain, deterministic code — same input always produces the same behavior. An agent that hallucinates or is prompt-injected into proposing a bad refund still has to pass a real policy check, not a second AI's opinion.
- **Paytm's merchant key never touches Parmana or the agent-facing side.** `PAYTM_MERCHANT_ID`/`PAYTM_MERCHANT_KEY` exist only in this service. Even a fully compromised Parmana process has no path to them.
- **Auditable by construction.** Every approve/deny decision traces back to Parmana's policy engine's own output, not an opaque model response — "why was this allowed" always has a concrete answer.
- **Idempotent by design on the connector path.** `GatewayPaytmAdapter` (Parmana side) derives `refId` deterministically from `(orderId, txnId)` — a retried request for the same logical refund always reuses the same `refId`, and Paytm's own `/refund/apply` is idempotent per `refId`. This is what actually prevents a duplicate refund on retry, not the store below.
- **Cryptographically bound, not just secret-gated (added 2026-09-13).** `/connector/paytm-refund` requires a signature over the exact executed parameters, with a 60-second expiry. Possession of the shared secret alone is no longer sufficient to forge a refund through this endpoint.

### Trade-offs and known limitations — read before relying on this in production

- **Extra network hop.** Unlike HubSpot/GitHub (in-process, one call), every Paytm refund is Parmana → this service → Paytm — more latency, and two independently deployed services to keep operationally in sync.
- **Two repos must agree on the wire contract exactly.** The canonical string this service verifies (`canonicalPaytmAuthorizationString`) must stay byte-for-byte identical to Parmana's copy of the same function. If the two silently drift, every signature fails verification — there is no automated cross-repo check for this today, only matching unit tests maintained by hand on each side.
- **`/agent/refunds`'s idempotency store is in-memory, not durable** (`MemoryRefundIdempotencyStore`, the default in `governed-refund.ts` when no store is passed — and `src/server/handler.ts` passes none). A process restart or a serverless cold start loses it. `docs/AGENT_REFUNDS_CONTRACT.md` documents this as a known, current limitation — the connector-path idempotency above (via deterministic `refId`) is unaffected by this, since that guarantee comes from Paytm's own API, not this store.
- **No gated live-integration test suite exists yet** against a real Paytm account or a real deployed counterpart — both repos' suites run entirely against mocks. The signature/authorization logic is well covered; an actual end-to-end run against live Paytm has not been exercised as part of this work.
- **The signing key behind the connector signature is currently a local file key, not AWS KMS** — see the AgentLabsBuildathon repo's ADR-0009 and 2026-09-13 ship log. The signature check is real and enforced today; the stronger "the key never leaves a hardware/cloud boundary" property is not yet true.

## Security update — 2026-09-13: `/connector/paytm-refund` now requires a signature

**What changed:** `POST /connector/paytm-refund` (the endpoint Parmana's own gateway calls after it has already approved a refund internally — the *other* path through this diagram, distinct from the agent-facing `/agent/refunds` flow above) now requires a cryptographic signature from Parmana over the exact `businessTransactionId`/`orderId`/`txnId`/`amount` being executed, in addition to the pre-existing bearer shared secret. See `docs/SECURITY.md`'s "Connector authorization" section for the full trust model.

**Why:** this endpoint is a public HTTPS route (it has to be, per `PAYTM_CONNECTOR_URL`'s own contract) that previously trusted the bearer secret alone. Anyone who obtained that secret — leaked from either side, or from a compromised host — could call it directly with self-chosen parameters and it would be honored, completely bypassing Parmana's policy engine, rate limits, and spend caps. This was found by a code-level audit, not by an incident.

**What it enables:** a refund can now execute through this endpoint only if Parmana's policy engine cryptographically signed off on those *exact* parameters. Possession of the shared secret alone is no longer sufficient to forge a refund — an attacker would also need Parmana's private signing key, which never leaves the signer backend in use (today: the local file key; AWS KMS once provisioned).

## Invariants

- Same policy + different valid payload can produce different deterministic decisions.
- DENIED means Paytm is not invoked.
- APPROVED permits exactly the authorized operation.
- Authorized parameters are bound to the executed request; mismatches fail closed.
- Paytm authentication/checksum is separate from Parmana authorization.
- **`/connector/paytm-refund` additionally requires a valid, unexpired signature over the exact executed parameters — the shared secret alone is not sufficient (added 2026-09-13).**
- Secrets are supplied through the runtime environment and are never committed.

Implementation begins with the connector contract, Paytm API client, authorization boundary, and evidence model before demo-specific flows are added.

## Documentation

- **[docs/AGENT_REFUNDS_CONTRACT.md](docs/AGENT_REFUNDS_CONTRACT.md)** — the complete `POST
  /agent/refunds` contract for anyone integrating an agent against this service: request/response
  shapes, every error case, and known limitations (including that idempotency is not durable on the
  actual deployed service).
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the execution boundary and security properties.
- **[docs/SECURITY.md](docs/SECURITY.md)** — the security model for both endpoints this service exposes, including the `/connector/paytm-refund` authorization-signature check above and the full required-secrets list.
- **[docs/INTEGRATION-TESTS.md](docs/INTEGRATION-TESTS.md)** — the denied/approved test plan.
- **[openapi/paytm-agent.yaml](openapi/paytm-agent.yaml)** — the machine-readable schema.
