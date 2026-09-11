# Security model

## Authority boundary

The agent is untrusted with respect to financial authority. It can construct a refund proposal but cannot invoke the Paytm connector directly. `GovernedPaytmRefundService` is the execution boundary.

## Parmana

Parmana answers whether the requested action is authorized under the deployed policy. The caller must use the intended service principal. The integration does not treat an LLM response as authorization.

## Paytm

Paytm credentials authenticate the downstream merchant request. They do not replace Parmana authorization.

## Secrets

Required secrets are environment variables:

- `PARMANA_API_KEY`
- `PAYTM_MERCHANT_ID`
- `PAYTM_MERCHANT_KEY`

Do not commit these values. Do not log them or raw Authorization headers.

## Replay and duplicate protection

A refund `refId` is bound to `orderId`, `txnId`, and amount. Reusing a refId for different financial parameters is rejected. An ambiguous network outcome is recorded as `UNKNOWN`; the connector does not automatically issue another refund.

## Callback security

Paytm callbacks must pass checksum verification before they can update local refund state. Callback data is evidence from a downstream system, not authorization to initiate another financial action.

## Production readiness gates

Before production:

1. validate the current Paytm merchant API contract and endpoint for the account;
2. run the denied scenario and prove zero Paytm invocation;
3. run the approved scenario in staging;
4. reconcile the approved refund by status;
5. review logs for secret leakage;
6. replace the in-memory idempotency store with a durable transactional store;
7. only then enable production credentials.
