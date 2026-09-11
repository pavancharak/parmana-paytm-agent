# Parmana × Paytm Architecture

## Execution boundary

```text
Agent
  │
  │ refund intent + independently obtained signals
  ▼
Parmana /execute
  │
  ├── policy: customer-refund@1.0.0
  ├── bound signal: refundAmount == intent.parameters.amount
  ├── deterministic policy decision
  └── signed execution evidence
       │
       ├── REJECT ───────────────► stop
       │                            Paytm calls = 0
       │
       └── APPROVE
             │
             ▼
       exact-parameter binding
             │
             ▼
       PaytmRefundConnector
             │
             ▼
       Paytm Refund API
```

## Security properties

1. The agent never receives a direct Paytm execution primitive.
2. Parmana evaluates the refund before any Paytm side effect.
3. `orderId`, `txnId`, and `amount` are carried through the authorization boundary and must match before execution.
4. A denied policy decision terminates without a Paytm call.
5. A parameter mismatch after approval fails closed.
6. Paytm authentication/checksum is downstream request authentication; it does not replace Parmana authorization.

## Policy

The integration targets the deployed `customer-refund@1.0.0` policy. Its refund amount is bound to `intent.parameters.amount`; the policy approves only when eligibility, manager approval, fraud assessment and the amount threshold are satisfied.

The connector must not copy those rules locally. Parmana remains the policy authority.

## Failure handling

A network failure after a refund request may be ambiguous because refund processing can be asynchronous. The system must reconcile the refund using the same merchant reference/status path before considering a retry. It must not blindly generate a new reference and submit a second refund.
