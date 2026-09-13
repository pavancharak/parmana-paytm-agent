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
