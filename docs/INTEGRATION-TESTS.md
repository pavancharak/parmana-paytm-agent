# Integration test plan

The connector must be demonstrated with two payloads against the same deployed Parmana policy: `customer-refund@1.0.0`.

## Scenario A — denied

Example inputs:

- `orderId`: a real settled staging order
- `txnId`: its Paytm transaction ID
- `amount`: `50000.00`
- `refundEligible`: `true`
- `managerApproved`: `false`
- `fraudCheckPassed`: `true`
- `maximumRefundAmount`: `1000`

Expected:

1. Parmana evaluates the request.
2. Decision is `DENIED`.
3. `/agent/refunds` returns HTTP 403.
4. Paytm refund invocation count is exactly **0**.
5. No Paytm financial side effect occurs.

## Scenario B — approved

Use the same order/transaction only if the staging merchant account and Paytm refund rules permit the test. Otherwise use a separate settled staging transaction.

Example inputs:

- `amount`: `500.00`
- `refundEligible`: `true`
- `managerApproved`: `true`
- `fraudCheckPassed`: `true`
- `maximumRefundAmount`: `1000`

Expected:

1. Parmana evaluates the request using the same policy version.
2. Decision is `APPROVED`.
3. Exact `orderId`, `txnId`, and amount binding passes.
4. Paytm `/refund/apply` is invoked exactly once for the `refId`.
5. The returned Paytm status is reconciled before the result is considered final.

## Evidence

Capture, without secrets or full sensitive payloads:

- Parmana transaction ID
- policy name/version
- authorization decision
- authorized amount
- Paytm `refId`
- Paytm response/status code
- final refund status
- timestamp and environment

Never commit merchant keys, Parmana API keys, Authorization headers, or production customer/payment data.

## Important

A passing unit test is not evidence of a real refund. A production demonstration requires a real staging merchant credential and a real settled staging transaction. Do not run the approved scenario against production until staging reconciliation has succeeded.
