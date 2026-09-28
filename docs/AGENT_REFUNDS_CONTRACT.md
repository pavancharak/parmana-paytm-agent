# `POST /agent/refunds` — Complete Contract

This is the prose companion to `openapi/paytm-agent.yaml`: what to send, what you get back, why
each field exists, and how to troubleshoot every failure mode. Grounded directly in this
repository's source (`src/server/handler.ts`, `src/agent/refund-agent.ts`, `src/governed-refund.ts`,
`src/parmana/refund-authorizer.ts`, `src/parmana/client.ts`) — every claim below is cited.

**This is a different integration pattern from `parmana-phinite-agent`.** That repository's agent
calls Parmana's `POST /execute` directly. Here your agent calls *this* service, and this service
calls Parmana's `POST /execute` on your behalf.

**Exactly one Paytm call per approved refund, made through Parmana.** When Parmana approves, it
releases the refund inside that same `/execute` call: its Execution Gateway sends it to this
service's own `POST /connector/paytm-refund` (authenticated with `PAYTM_CONNECTOR_SHARED_SECRET` and
a signed authorization), which calls Paytm. The signed Trust Record Parmana returns holds what Paytm
reported, and `/agent/refunds` returns that. `/agent/refunds` never calls Paytm itself
(`src/governed-refund.ts` has no Paytm client). Until 2026-09-28 it did, after Parmana's call, with
a different `refId`, so an approved refund would have been paid twice; see "History" below.

An agent integrating against `/agent/refunds` never calls `/connector/paytm-refund` directly.

**The policy version is read, never written into the code.** Before every refund this service asks
Parmana `GET /policies/in-effect?capability=paytm:refund` and declares the version it returns
(`src/parmana/refund-authorizer.ts`). Parmana enforces the version most recently approved, so an
approval of a new version needs no change here. If the lookup fails (no approved version, lookup
unavailable, key not allowed), no refund is attempted and the request fails with `500`.

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
    "managerApproved": false,
    "fraudCheckPassed": true,
    "maximumRefundAmount": 1000
  },
  "approvalArtifact": { "payload": { "...": "..." }, "signature": { "...": "..." } }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `orderId` | string | yes | Sent to Parmana as `intent.target` and `intent.parameters.orderId`; Parmana's connector sends it to Paytm. |
| `txnId` | string | yes | Sent to Parmana as `intent.parameters.transactionId` (note the field name difference); Parmana's connector sends it to Paytm as `txnId`. |
| `refId` | string | **no** | If omitted, generated as `` PARMANA-<uuid> `` (`src/agent/refund-agent.ts`). It is this service's idempotency key and the seed of the Parmana business transaction id (the same `refId` always maps to the same transaction). It is **not** the refId Paytm sees: Parmana derives that from (`orderId`, `txnId`) (`deriveDeterministicPaytmRefId` in Parmana), and it is returned as `refund.refId`. |
| `amount` | **string**, not a number | yes | `"500.00"`, not `500`. Validated as a positive finite number and normalized to two decimals (`normalizeAmount`, `src/governed-refund.ts`); a non positive or non numeric string fails with `500`. |
| `reason` | string | no | Accepted but **not sent to Paytm**: Parmana's connector call carries only `orderId`, `txnId`, `refId` and `amount`. |
| `signals.refundEligible` / `fraudCheckPassed` | boolean | yes | Forwarded to Parmana as policy signals. Must come from an independent business system, never inferred from what the customer said. Parmana does not verify them. |
| `signals.managerApproved` | boolean | yes | Leave `false` unless you send `approvalArtifact`. Under `customer-refund` 1.1.0 Parmana refuses `managerApproved: true` without a signed approval it can verify. |
| `signals.maximumRefundAmount` | number | yes (this service's own schema) | **Sent to Parmana as an extra signal that no current policy reads.** The limits are inside the policy (1.1.0: up to 10000 automatic, up to 100000 with a signed manager approval, above that refused). A lower value here has **no effect**. |
| `approvalArtifact` | object | no | A manager's signed approval (made with Parmana's `scripts/sign-approval.ts`), needed above 10000. Forwarded unchanged as `signals.approvalArtifact`, with `managerApproved` sent as `true`. Parmana checks the issuer is trusted, the signature, the expiry, that it names this `orderId` and covers this `amount`, and uses it once. This service does not inspect it beyond requiring an object. |

## Responses

| Status | Body | When | Source |
|---|---|---|---|
| `401` | `{"error": "unauthorized"}` | Missing/wrong `Authorization` header. | `handler.ts:35` |
| `200` | `{"decision": "APPROVED", "authorizationId": "<uuid>", "transactionId": "<uuid>", "refund": {"success": true, "refId": "refid_...", "resultStatus": "...", "resultCode": "..."}}` | Parmana approved, released the refund to Paytm once, and Paytm reported success. `refund` is read from the execution evidence in Parmana's signed Trust Record. | `governed-refund.ts`, `refund-authorizer.ts` (`readRefundExecution`) |
| `502` | Same shape, with `"refund": {"success": false, ...}` | Parmana approved and released the refund, but Paytm did not report success (`resultStatus`, `resultCode` say why). Reconcile with Paytm before trying again; do not simply retry with a new `refId`. | `handler.ts` |
| `403` | `{"decision": "DENIED", "authorizationId": "", "transactionId": "<uuid>", "reason": "<Parmana's policy reason>"}` | Parmana refused. **`authorizationId` is an empty string `""` here, not `null` or omitted.** Nothing is sent to Paytm. | `governed-refund.ts`, `refund-authorizer.ts` |
| `500` | `{"error": "<message>"}` | **Everything else**, see below. There is no `code` field in this bucket. | `handler.ts` |

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
- **The policy in effect could not be read** (`"Parmana policy in effect lookup for paytm:refund
  failed (HTTP 409|503|403) ..."`). Nothing was attempted.
- **An approval with no execution result** (`"... no execution evidence; the Paytm outcome is
  unknown ..."`). Parmana approved, so the refund may have been released: reconcile before retrying.
- **A binding mismatch after approval** (`"authorized ... mismatch"`). Parmana has already released
  the refund; the `refId` is left `UNKNOWN` for reconciliation.
- **An `approvalArtifact` that is not an object** (`"approvalArtifact must be the signed approval object"`).

**Practically:** if you get a `500`, read `error` before assuming anything about whether Parmana
authorized the transaction. In particular, an ambiguous-outcome `500` does **not** mean the refund
was denied — it means the outcome is genuinely unknown and needs reconciliation, the same distinction
`docs/connectors/CONNECTING_AN_AGENT.md` makes for the direct-to-Parmana pattern.

## Known limitation: idempotency is not durable on the deployed service

`GovernedPaytmRefundService` defaults to `MemoryRefundIdempotencyStore` when no store is passed in
(`governed-refund.ts`), and that class's own doc comment says explicitly: **"In-memory
implementation for tests/local development only."** `src/server/handler.ts` constructs the service
with no store, so the deployed service (`api/index.ts` on Vercel) uses this in memory store.

Two things still protect against a duplicate Paytm refund across instances: the same `refId` always
maps to the same Parmana business transaction, so a retry finds Parmana's existing record instead of
executing again; and Paytm sees one refId per (`orderId`, `txnId`), so it treats a repeat as the same
refund. The second also means **only one refund per Paytm transaction can go through this path**: a
second, partial refund of the same `txnId` reuses the same Paytm refId.

The in memory store's "reconcile before retrying" check holds only within one warm instance. A
durable `RefundIdempotencyStore` does not exist in this repository today.

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

Expect `403`, `{"decision":"DENIED", ...}` (above 10000 with no signed manager approval), and zero
Paytm calls.

**Approved** (up to 10000, no manager approval needed):

```bash
curl -i https://<deployment>/agent/refunds \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary '{
    "orderId": "ORD-STAGING-002",
    "txnId": "TXN-STAGING-002",
    "amount": "500.00",
    "signals": { "refundEligible": true, "managerApproved": false, "fraudCheckPassed": true, "maximumRefundAmount": 1000 }
  }'
```

Expect `200`, `{"decision":"APPROVED", "refund": {"success": true, ...}}`, and exactly one Paytm
call, made by `/connector/paytm-refund` when Parmana releases the refund.

**Above 10000:** add the manager's signed approval as `"approvalArtifact": {...}` (made for this
`orderId` and an amount at least this refund's).

## History

Until 2026-09-28 `GovernedPaytmRefundService` also called Paytm itself after Parmana approved, with
the caller's `refId`, while Parmana had already released the refund with its own refId: two refunds
Paytm would not recognize as duplicates. Before 2026-09-27, when `customer-refund` 1.0.0 was in
effect, any approved refund took both paths wherever Parmana's `PAYTM_CONNECTOR_URL` pointed at this
service (a live run on 2026-09-20 did reach `/connector/paytm-refund`). From 2026-09-27, when 1.1.0
was approved, the defect was dormant: this service still declared 1.0.0, which Parmana refuses, so
no refund was approved. Fixed by removing the direct call and reading the policy version from Parmana.

## What this document does not cover

- `POST /connector/paytm-refund` (the other endpoint this service exposes) — see `docs/SECURITY.md`'s
  "Connector authorization (`/connector/paytm-refund`)" section for its trust model, and
  `AgentLabsBuildathon`'s `docs/connectors/PAYTM_CONNECTOR.md` for the full wire contract.
- Adding a durable idempotency store — open work, not yet implemented here.
- The direct-to-Parmana integration pattern (`parmana-phinite-agent`) — see AgentLabsBuildathon's
  `docs/connectors/CONNECTING_AN_AGENT.md`.
