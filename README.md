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
