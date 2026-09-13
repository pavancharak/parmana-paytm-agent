# `POST /agent/refunds` — Complete Contract

This is the prose companion to `openapi/paytm-agent.yaml`: what to send, what you get back, why
each field exists, and how to troubleshoot every failure mode. Grounded directly in this
repository's source (`src/server/handler.ts`, `src/agent/refund-agent.ts`, `src/governed-refund.ts`,
`src/parmana/refund-authorizer.ts`, `src/parmana/client.ts`) — every claim below is cited.

**This is a different integration pattern from `parmana-phinite-agent`.** That repository's agent
calls Parmana's `POST /execute` directly. This service's `/agent/refunds` is a second, independent
pattern: your agent calls *this* service, and this service itself calls Parmana on your behalf, then
calls Paytm if approved. Don't conflate the two — see
`AgentLabsBuildathon`'s `docs/connectors/CONNECTING_AN_AGENT.md` for the direct-to-Parmana pattern.

**This service also exposes `POST /connector/paytm-refund`** (`src/server/handler.ts`) — that is a
*different* endpoint, authenticated with a *different* secret (`PAYTM_CONNECTOR_SHARED_SECRET`, not
`AGENT_API_KEY`), called by Parmana's own Execution Gateway after it has already approved a
transaction submitted through the *other* pattern above. An agent integrating against
`/agent/refunds` never calls `/connector/paytm-refund` directly, and should not need to know it
exists.

## Authentication

```
Authorization: Bearer <AGENT_API_KEY>
```

One static shared secret (`config.agentApiKey`, `src/server/handler.ts`), compared with a plain
string equality check (`authorized()`). **This is not a per-caller identity system** — unlike
Parmana's own caller registry (which scopes each API key to specific capabilities), every holder of
this one key can propose any refund this service accepts. If you need per-caller scoping or an audit
trail of *which* agent instance proposed a given refund, that isn't provided by this endpoint today.

## Request

```json
{
  "orderId": "ORD-1001",
  "txnId": "TXN-1001",
  "refId": "PARMANA-a1b2c3d4-...",
  "amount": "500.00",
  "reason": "Arrived damaged",
  "signals": {
    "refundEligible": true,
    "managerApproved": true,
    "fraudCheckPassed": true,
    "maximumRefundAmount": 1000
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | yes | Passed through to Parmana as `intent.target` and `intent.parameters.orderId`, and to Paytm as `orderId`. |
| `txnId` | string | yes | Sent to Parmana as `intent.parameters.transactionId` (note the field-name difference) and to Paytm as `txnId`. |
| `refId` | string | **no** | If omitted, auto-generated as `` PARMANA-<uuid> `` (`src/agent/refund-agent.ts:12`). This is also the idempotency key — see "Known limitation" below before relying on omitting it for a retry. |
| `amount` | **string**, not a number | yes | `"500.00"`, not `500`. Validated as a positive finite number and normalized to two decimals (`normalizeAmount`, `src/governed-refund.ts:44`); a non-positive or non-numeric string throws (surfaces as `500`, see Troubleshooting). |
| `reason` | string | no | Forwarded to Paytm as `comments` if present and non-blank (`src/paytm/refund.ts:31`). |
| `signals.refundEligible` / `managerApproved` / `fraudCheckPassed` | boolean | yes | Forwarded to Parmana's `customer-refund@1.0.0` policy signals. Must come from an independent business system — never inferred from what the customer said. |
| `signals.maximumRefundAmount` | number | yes (per this service's own schema) | **Sent to Parmana as an extra signal, but Parmana's `customer-refund@1.0.0` policy does not read it.** The real cap is a hardcoded `10000` inside the policy's rules (fixed in AgentLabsBuildathon commit `f4713e4`, which removed the equivalent unenforced schema field from the policy itself). Sending a lower value here has **no effect** on what Parmana actually approves — don't rely on it as a per-caller cap. |

## Responses

| Status | Body | When | Source |
|---|---|---|---|
| `401` | `{"error": "unauthorized"}` | Missing/wrong `Authorization` header. | `handler.ts:35` |
| `200` | `{"decision": "APPROVED", "authorizationId": "<uuid>", "transactionId": "<uuid>", "paytm": {"body": {...}, "head": {...}, "raw": ...}}` | Parmana approved **and** Paytm's `/refund/apply` was called. `paytm.body` is Paytm's own raw JSON response, passed through unmodified. | `governed-refund.ts:36`, `paytm/types.ts` |
| `403` | `{"decision": "DENIED", "authorizationId": "", "transactionId": "<uuid>", "reason": "<Parmana's policy reason>"}` | Parmana rejected the transaction. **Note `authorizationId` is an empty string `""` here, not `null` or omitted** — check for it explicitly if your client distinguishes "no id" from "empty id." Paytm is never called. | `governed-refund.ts:26`, `refund-authorizer.ts:136` |
| `500` | `{"error": "<message>"}` | **Everything else** — see below. There is no `code` field for anything in this bucket; the only machine-distinguishable outcomes this endpoint gives you are `APPROVED` and `DENIED`. | `handler.ts:49-51` |

### Everything that collapses into that one `500` bucket

This endpoint's error handling is less granular than Parmana's own. All of the following produce
the *same* `500 {"error": "..."}` shape, distinguished only by reading the message text:

- **Ambiguous Parmana outcome (HTTP 409/5xx from Parmana), unrecoverable.** `refund-authorizer.ts`
  tries once to recover the real decision via `GET /trust-records/:id`; if that also returns nothing,
  the original `ParmanaExecutionAmbiguousError` propagates. Message contains "Parmana execution
  outcome is ambiguous... reconcile the persisted transaction before retrying."
- **Invalid amount.** `"refund amount must be positive"` — a non-numeric or non-positive `amount`.
- **Idempotency conflict.** `"refund already submitted or ambiguous for refId; reconcile status
  before retrying"` (an existing record for this `refId` is `CONFIRMED`/`SUBMITTED`/`PENDING`/
  `UNKNOWN`) or `"refund execution already claimed for refId; reconcile status before retrying"`
  (a concurrent request won the claim first). See "Known limitation" below — this protection is not
  reliable on the actual deployed service.
- **A mismatched retry.** `"refId is already bound to a different refund"` — you reused a `refId`
  with a different `orderId`/`txnId`/`amount` than its first use.
- **A non-`POLICY_DENIED` Parmana rejection** (e.g. a structural `400`, or a `403` without the exact
  `POLICY_DENIED` shape) — surfaces as `"Parmana API HTTP <status>: ..."`.
- **A genuine Paytm-side failure** during `initiateRefund` — whatever Paytm's transport throws.

**Practically:** if you get a `500`, read `error` before assuming anything about whether Parmana
authorized the transaction. In particular, an ambiguous-outcome `500` does **not** mean the refund
was denied — it means the outcome is genuinely unknown and needs reconciliation, the same distinction
`docs/connectors/CONNECTING_AN_AGENT.md` makes for the direct-to-Parmana pattern.

## Known limitation: idempotency is not durable on the deployed service

`GovernedPaytmRefundService` defaults to `MemoryRefundIdempotencyStore` when no store is passed in
(`governed-refund.ts:15`), and that class's own doc comment says explicitly: **"In-memory
implementation for tests/local development only."** `src/server/handler.ts` constructs the service
with no third argument — so the actual deployed service (`api/index.ts` on Vercel, a serverless
Node.js Function) uses this in-memory store.

**Why this matters:** a serverless function's module scope does not reliably persist across
invocations — a cold start creates a fresh, empty store, and there is no guarantee two calls for the
same `refId` land on the same warm instance. The "reconcile before retrying" protection this
service's code implements is real *within a single warm process*, but is **not a reliable guarantee
on the actual deployment** as configured today. Do not depend on it to prevent a duplicate Paytm
refund across retries that might hit different instances. If you need real cross-invocation
idempotency, a durable `RefundIdempotencyStore` implementation needs to be wired in — none exists in
this repository today.

## Worked examples

**Denied** (mirrors `docs/INTEGRATION-TESTS.md` Scenario A):

```bash
curl -i https://<deployment>/agent/refunds \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "orderId": "ORD-STAGING-001",
    "txnId": "TXN-STAGING-001",
    "amount": "50000.00",
    "signals": { "refundEligible": true, "managerApproved": false, "fraudCheckPassed": true, "maximumRefundAmount": 1000 }
  }'
```

Expect `403`, `{"decision":"DENIED", ...}`, and zero Paytm calls.

**Approved:**

```bash
curl -i https://<deployment>/agent/refunds \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "orderId": "ORD-STAGING-002",
    "txnId": "TXN-STAGING-002",
    "amount": "500.00",
    "signals": { "refundEligible": true, "managerApproved": true, "fraudCheckPassed": true, "maximumRefundAmount": 1000 }
  }'
```

Expect `200`, `{"decision":"APPROVED", "paytm": {...}}`.

## What this document does not cover

- `POST /connector/paytm-refund` (the other endpoint this service exposes) — see `docs/ARCHITECTURE.md`.
- Adding a durable idempotency store — open work, not yet implemented here.
- The direct-to-Parmana integration pattern (`parmana-phinite-agent`) — see AgentLabsBuildathon's
  `docs/connectors/CONNECTING_AN_AGENT.md`.
