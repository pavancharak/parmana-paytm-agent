# Security model

This document covers both endpoints this service exposes. They have different trust models and
should not be conflated:

- `POST /agent/refunds` — an untrusted agent proposes a refund; this service is what calls back into
  Parmana for real policy authorization before executing anything. See "Authority boundary" below.
- `POST /connector/paytm-refund` — the *opposite* direction: Parmana's own gateway (`GatewayPaytmAdapter`
  in the AgentLabsBuildathon repo) has already authorized a refund internally and calls this endpoint
  to execute it. See "Connector authorization (`/connector/paytm-refund`)" below.

## Authority boundary (`/agent/refunds`)

The agent is untrusted with respect to financial authority. It can construct a refund proposal but cannot invoke the Paytm connector directly. `GovernedPaytmRefundService` is the execution boundary.

## Parmana

Parmana answers whether the requested action is authorized under the deployed policy. The caller must use the intended service principal. The integration does not treat an LLM response as authorization.

## Connector authorization (`/connector/paytm-refund`)

Added 2026-09-13 (ADR-0009 Phase 2B in the AgentLabsBuildathon repo) after a code-level audit found a
real gap: this endpoint previously verified only the `PAYTM_CONNECTOR_SHARED_SECRET` bearer token and
a string match on `businessTransactionId` -- **never a cryptographic signature**. Because this
endpoint is a public HTTPS route (per `PAYTM_CONNECTOR_URL`'s own contract), anyone who obtained the
shared secret -- from either side, or from a compromised host with filesystem access -- could call it
directly with a self-chosen `orderId`/`txnId`/`amount` and it would be honored, completely bypassing
Parmana's policy engine, rate limits, and spend caps.

This is now closed: `executeAuthorizedConnectorRequest` (`src/server/handler.ts`) requires
`authorization.signature`/`keyId`/`expiresAt` on every request, fetches Parmana's public key live via
`GET /keys/:keyId` (`src/parmana/keys.ts`, deliberately unauthenticated -- that route is mounted
ahead of Parmana's own caller-auth for exactly this purpose), rebuilds the identical canonical string
(`canonicalPaytmAuthorizationString`, `src/parmana/authorization.ts` -- must stay byte-for-byte
identical to the same-named function in the AgentLabsBuildathon repo), and verifies before ever
calling `connector.initiateRefund()`. The shared secret is still checked too -- this is additive
defense in depth, not a replacement.

**The shared secret alone is no longer sufficient to execute a refund through this endpoint.**

## Paytm

Paytm credentials authenticate the downstream merchant request. They do not replace Parmana authorization.

## Secrets

Required secrets are environment variables (all `required()` at startup in `src/server/handler.ts` --
the process refuses to boot if any is missing):

- `PARMANA_API_KEY`
- `PARMANA_PRINCIPAL_ID`
- `PAYTM_MERCHANT_ID`
- `PAYTM_MERCHANT_KEY` (must be exactly 16 bytes, not 16 characters loosely -- `assertMerchantKey`, `src/paytm/auth.ts`)
- `PAYTM_CONNECTOR_SHARED_SECRET` (must match the same value configured on the Parmana/`GatewayPaytmAdapter` side)
- `AGENT_API_KEY` (protects `/agent/refunds` specifically, distinct from the above)

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
