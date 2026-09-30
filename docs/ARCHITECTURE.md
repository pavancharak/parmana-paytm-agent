# Parmana × Paytm Architecture

## Execution boundary

```text
Agent
  │
  │ POST /agent/refunds: refund intent, independently obtained signals,
  │ optional signed manager approval
  ▼
this service (/agent/refunds)
  │  GET  /policies/in-effect?capability=paytm:refund   (policy version, read every time)
  │  POST /execute
  ▼
Parmana /execute
  ├── policy: customer-refund, the version most recently approved (1.2.0 since 2026-09-28)
  ├── bound signal: refundAmount == intent.parameters.amount
  ├── signed manager approval verified when managerApproved is true
  ├── deterministic policy decision
  │
  ├── REJECT ───────────────► 403 to the agent, Paytm calls = 0
  │
  └── APPROVE: released inside the same /execute call
        │
        ▼
  Parmana Execution Gateway (signs the authorization)
        │
        ▼
  this service (/connector/paytm-refund): verifies shared secret and signature
        │
        ▼
  Paytm Refund API       (exactly one call; refId derived by Parmana from orderId, txnId and
                          this service's refId, sent as refundReference; reason as the comment)
        │
        ▼
  result recorded as execution evidence in the signed Trust Record,
  returned by /execute and passed back to the agent
```

## Security properties

1. The agent never receives a Paytm execution primitive. `/agent/refunds` has no Paytm client; the
   only Paytm call is made by `/connector/paytm-refund` when Parmana releases an approved refund.
2. Parmana evaluates the refund before any Paytm side effect.
3. `orderId`, `txnId`, and `amount` are carried through the authorization boundary; the connector
   verifies Parmana's signature over them before calling Paytm.
4. A refused decision ends without a Paytm call.
5. A parameter mismatch in Parmana's answer is reported and the refId left for reconciliation; it
   cannot undo a refund Parmana has already released.
6. Paytm authentication/checksum is downstream request authentication; it does not replace Parmana
   authorization.

## Policy

The service declares the `customer-refund` version Parmana reports as in effect
(`GET /policies/in-effect`), never a version written into the code. Under 1.2.0 (in effect since
2026-09-28) every refund above 0 and up to 100000 needs the eligibility and fraud checks **and** a
signed manager approval for that order covering the amount; anything else is refused. Since
2026-09-30 Parmana refuses any policy that could approve an action without a signed approval. The refund amount is bound to
`intent.parameters.amount`.

The service must not copy those rules locally. Parmana remains the policy authority.

## Failure handling

A network failure after a refund request may be ambiguous because refund processing can be
asynchronous. The system must reconcile the refund using the same merchant reference/status path
before considering a retry. It must not blindly generate a new reference and submit a second refund.
