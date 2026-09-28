# Integration test plan

The connector must be demonstrated with two payloads against the same deployed Parmana policy: the
`customer-refund` version in effect (`GET /policies/in-effect?capability=paytm:refund`, 1.1.0 at the
time of writing).

## Scenario A: denied

Example inputs:

- `orderId`: a real settled staging order
- `txnId`: its Paytm transaction ID
- `amount`: `50000.00`
- `refundEligible`: `true`
- `managerApproved`: `false`, no `approvalArtifact`
- `fraudCheckPassed`: `true`
- `maximumRefundAmount`: `1000`

Expected:

1. Parmana evaluates the request.
2. Decision is `DENIED` (above 10000 needs a signed manager approval).
3. `/agent/refunds` returns HTTP 403.
4. Paytm refund invocation count is exactly **0**.
5. No Paytm financial side effect occurs.

## Scenario B: approved

Use the same order/transaction only if the staging merchant account and Paytm refund rules permit
the test. Otherwise use a separate settled staging transaction.

Example inputs:

- `amount`: `500.00`
- `refundEligible`: `true`
- `managerApproved`: `false`
- `fraudCheckPassed`: `true`
- `maximumRefundAmount`: `1000`

Expected:

1. Parmana evaluates the request using the same policy version.
2. Decision is `APPROVED`.
3. Parmana releases the refund to `/connector/paytm-refund`, which verifies the signed authorization.
4. Paytm `/refund/apply` is invoked **exactly once**, by `/connector/paytm-refund`. `/agent/refunds`
   makes no Paytm call of its own.
5. `/agent/refunds` returns `refund` (from the Trust Record's execution evidence); the Paytm status
   is reconciled before the result is considered final.

## Scenario C: approved with a signed manager approval

As Scenario A, plus `approvalArtifact`: a manager approval signed with
`scripts/sign-approval.ts` in the Parmana repository, for this `orderId` and an amount of at least
`50000.00`, by an issuer in Parmana's `TRUSTED_APPROVAL_ISSUERS`. Expected: `APPROVED`, one Paytm
call. Sending the same approval again is refused (it is used once).

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

Never commit merchant keys, Parmana API keys, Authorization headers, or production customer/payment
data.

## Important

A passing unit test is not evidence of a real refund. A production demonstration requires a real
staging merchant credential and a real settled staging transaction. Do not run the approved scenario
against production until staging reconciliation has succeeded.
