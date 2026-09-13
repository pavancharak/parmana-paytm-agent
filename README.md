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

## Invariants

- Same policy + different valid payload can produce different deterministic decisions.
- DENIED means Paytm is not invoked.
- APPROVED permits exactly the authorized operation.
- Authorized parameters are bound to the executed request; mismatches fail closed.
- Paytm authentication/checksum is separate from Parmana authorization.
- Secrets are supplied through the runtime environment and are never committed.

Implementation begins with the connector contract, Paytm API client, authorization boundary, and evidence model before demo-specific flows are added.

## Documentation

- **[docs/AGENT_REFUNDS_CONTRACT.md](docs/AGENT_REFUNDS_CONTRACT.md)** — the complete `POST
  /agent/refunds` contract for anyone integrating an agent against this service: request/response
  shapes, every error case, and known limitations (including that idempotency is not durable on the
  actual deployed service).
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the execution boundary and security properties.
- **[docs/INTEGRATION-TESTS.md](docs/INTEGRATION-TESTS.md)** — the denied/approved test plan.
- **[openapi/paytm-agent.yaml](openapi/paytm-agent.yaml)** — the machine-readable schema.
