# velvetAI Specification v1.1 Amendment

Status: Normative
Applies to: `spec.md` version 1.0
Date: 2026-10-21
Purpose: Correct and strengthen booking concurrency, PayPal finality, webhook reconciliation, outbox delivery, RLS, and agent confirmation requirements.

## Precedence

1. This amendment supersedes conflicting language in `spec.md` version 1.0.
2. Requirements in `spec.md` that are not changed here remain in force.
3. The implementation progress report shall cite this amendment when work is completed.
4. This amendment shall be merged into the next consolidated `spec.md` release as version 1.1.

---

# A. Correct Sprint Order

The implementation sequence is:

1. **Sprint Epic 1:** Platform foundation and catalog. Reported complete.
2. **Sprint Epic 2:** Concurrency-safe booking.
3. **Sprint Epic 3:** PayPal deposit, refunds, invoices, webhooks, ledger, and reconciliation.
4. **Sprint Epic 4:** MCP, WebMCP progressive enhancement, Ask AI, and security boundary.
5. **Sprint Epic 5:** Forecast visualization, Bryntum, Abuse Lab completion, deployment, and submission.

PayPal adapter contracts may be scaffolded during Epic 2. PayPal side effects shall not become part of booking confirmation until the Epic 2 hold, intent, confirmation, and commit state machine is verified.

---

# B. Booking and Slot-Claim Corrections

## B.1 Persisted blocking state

The overlap predicate shall depend only on persisted immutable/indexable values.

The system shall not use a partial-index or exclusion predicate containing:

```sql
hold_expires_at > now()
```

Time-dependent predicates are invalid for this purpose because index predicates must be immutable.

Each resource claim shall contain a persisted blocking state or generated `blocking` boolean.

Blocking states:

- `HELD`
- `COMMITTING`
- `CAPTURE_UNCERTAIN`
- `CONFIRMED`

Non-blocking states:

- `EXPIRED`
- `CANCELLED`
- `RELEASED`

An elapsed `hold_expires_at` shall not stop blocking until an atomic database transition changes the persisted state.

## B.2 Required exclusion constraint

The authoritative conflict constraint shall be equivalent to:

```sql
EXCLUDE USING gist (
  tenant_id WITH =,
  resource_id WITH =,
  blocked_during WITH &&
)
WHERE (blocking)
```

Intervals shall remain half-open:

```text
[start, end)
```

## B.3 Required supporting indexes

In addition to the GiST exclusion index, create:

```sql
CREATE INDEX resource_claim_calendar_idx
ON resource_claims (tenant_id, resource_id, starts_at)
INCLUDE (ends_at, state, hold_expires_at);
```

```sql
CREATE INDEX resource_claim_expiry_idx
ON resource_claims (hold_expires_at, id)
INCLUDE (tenant_id)
WHERE state = 'HELD';
```

Benchmark GiST key order using production-like data. If `resource_id` is globally unique and substantially more selective, compare:

```text
(resource_id, tenant_id, blocked_during)
```

against:

```text
(tenant_id, resource_id, blocked_during)
```

## B.4 Hold expiration

The system shall use:

- A scheduled global hold reaper.
- Targeted stale-hold expiration before retrying a conflicting slot.

The reaper shall:

1. Select expired held rows with `FOR UPDATE SKIP LOCKED`.
2. Transition state atomically.
3. Release blocking status.
4. Increment row version.
5. Append booking-state and outbox events in the same transaction.

Deadline checks shall use the database clock after acquiring the row lock.

For potentially long transactions, use:

```sql
clock_timestamp()
```

rather than transaction-start `now()` for hold expiry decisions.

## B.5 Capacity

The GiST exclusion constraint models capacity one.

For capacity greater than one, model discrete assignable resource units in MVP:

```text
Room 1
Room 2
Room 3
```

Do not replace the exclusion constraint with an application counter.

---

# C. RLS and Tenant Context

## C.1 Runtime role

The production runtime database role shall:

- Use `NOBYPASSRLS`.
- Not own tenant tables.
- Operate on tables with `ENABLE ROW LEVEL SECURITY`.
- Operate on tenant tables with `FORCE ROW LEVEL SECURITY`.

## C.2 Transaction-local context

Every tenant operation shall execute inside one explicit transaction and one physical pooled connection:

```sql
BEGIN;
SELECT set_config('app.tenant_id', :tenant_id, true);
-- tenant-scoped statements
COMMIT;
```

The third argument shall be `true`, making the context transaction-local.

Prohibited:

- Session-level `SET app.tenant_id`.
- Setting context in one autocommit call and executing the query through another.
- Runtime roles with `BYPASSRLS`.
- RLS helper functions marked `IMMUTABLE`.

Missing tenant context shall expose and modify zero tenant rows.

## C.3 Composite references

Every tenant-crossing foreign key shall include `tenant_id`.

This remains required even with RLS because referential-integrity checks can bypass ordinary RLS visibility.

## C.4 Required isolation test

With a database pool size of one, alternate Tenant A and Tenant B through:

- Successful commits.
- Rollbacks.
- Exceptions.
- Timeouts.
- Cancelled requests.
- Missing tenant-context initialization.

No request shall observe a previous request's tenant context.

---

# D. Signed Intent and Buyer Confirmation

## D.1 Separate artifacts

The booking protocol shall use three distinct artifacts:

1. Immutable server-side hold snapshot.
2. ES256 signed booking intent proving snapshot integrity.
3. Separate one-time buyer-confirmation record proving explicit approval.

The signed intent does not itself prove buyer approval.

The following shall never count as buyer approval:

- Model-generated text.
- A tool annotation.
- `user_confirmed: true` supplied by an agent.
- MCP elicitation navigation acceptance.
- Browser return parameters.
- PayPal order approval without the velvetAI transaction checks.

## D.2 Prepare operation

`prepare_booking.v1` shall:

1. Authenticate actor, OAuth client, and tenant.
2. Validate a closed schema with `additionalProperties: false`.
3. Canonicalize input deterministically.
4. Resolve authoritative service, resource, price, deposit, currency, and policy.
5. Create a versioned short-lived hold.
6. Persist an immutable snapshot.
7. Sign an intent referring to the snapshot.
8. Return an approval-interaction locator.

## D.3 Intent binding

The signed intent shall bind at least:

- Issuer and audience.
- Actor subject.
- OAuth client ID.
- Tenant.
- Unique intent ID.
- Issue, not-before, and expiration times.
- Purpose.
- Hold ID and version.
- Tool name/version and schema hash.
- Canonical argument hash.
- Verified merchant/payee.
- Deposit and total minor units.
- Currency and currency scale.
- Price version.
- Cancellation-policy ID/version/hash.
- Allowed transport surfaces.

JWS rules:

- Exact `typ`.
- ES256 allowlist.
- Known and locally configured `kid`.
- Pinned issuer and audience.
- No remote `jku` or `x5u`.
- No PII or payment credentials.
- Old verification keys retained through maximum artifact lifetime.

## D.4 Approval surface

The approval surface shall:

- Be separate from model-rendered content.
- Require the canonical buyer identity.
- Retrieve terms from the immutable server snapshot.
- Display merchant, service, slot, all-in price, deposit, currency, and cancellation terms.
- Display requesting agent/client identity.
- Use `Cache-Control: no-store`.
- Use `Referrer-Policy: no-referrer`.
- Use CSP with `frame-ancestors 'none'`.
- Avoid third-party scripts and analytics.

The approval URL shall contain only a random non-authorizing interaction locator.

## D.5 Commit contract

`commit_booking.v1` shall accept only:

```json
{
  "intent": "<signed-intent>",
  "confirmation": "<one-time-confirmation>",
  "idempotency_key": "<random-client-key>"
}
```

It shall not accept mutable copies of:

- Amount.
- Currency.
- Merchant/payee.
- Service.
- Slot.
- Deposit tier.
- Cancellation policy.

## D.6 Atomic confirmation consumption

One transaction shall:

1. Lock idempotency/commit operation.
2. Lock hold.
3. Lock confirmation.
4. Verify actor/client/tenant and artifact bindings.
5. Verify hold and policy versions.
6. Verify current tenant membership and authorization.
7. Verify database time is before all expirations.
8. Consume the confirmation exactly once.
9. Move the hold to `COMMITTING`.
10. Append audit and outbox events.
11. Commit.

No PayPal or network call shall occur while this transaction is open.

Unique constraints:

```text
(tenant_id, intent_jti)
(tenant_id, confirmation_jti)
(tenant_id, client_id, idempotency_key)
```

---

# E. MCP and WebMCP Transport Rules

## E.1 Shared application layer

REST, MCP, WebMCP, and Ask AI shall remain thin adapters to the same application commands and policy checks.

## E.2 MCP 2026-07-28

For MCP Streamable HTTP revision `2026-07-28`:

- Treat every request as an independently authenticated POST.
- Do not depend on `Mcp-Session-Id`.
- Do not depend on an initialize handshake.
- Validate `MCP-Protocol-Version`.
- Require the protocol header to match request `_meta`.
- Use explicit server-issued handles for cross-call state.
- Treat self-reported client metadata as non-authoritative.
- Bind state to authenticated actor, client, tenant, and handle server-side.

OAuth shall use:

- Authorization Code.
- PKCE S256.
- Exact redirect URIs.
- Issuer validation.
- Resource indicators.
- Audience-restricted tokens.
- No token passthrough to PayPal or other providers.

## E.3 WebMCP

WebMCP remains progressive enhancement.

- `consequentialHint` shall be treated as a UX hint, not authorization.
- Backend authorization and confirmation remain mandatory.
- Purchase tools shall remain same-origin.
- Cross-origin frames shall not receive booking tools.
- Registered tool definitions and schema versions shall be pinned.
- Ordinary UI, REST, MCP, and in-page Ask AI fallback shall remain functional.

---

# F. PayPal Payment Finality

## F.1 Deposit flow

The MVP flow remains:

1. Create a short-lived local hold.
2. Create PayPal Orders v2 order using `intent=CAPTURE`.
3. Buyer approves.
4. Backend captures.
5. Booking confirms only after capture status is `COMPLETED`.

The system shall not confirm a booking solely because the PayPal order status is `COMPLETED`.

Authoritative success condition:

```text
purchase_units[].payments.captures[].status == COMPLETED
```

Capture states:

- `COMPLETED`: funds credited; booking may confirm.
- `PENDING`: booking remains `CAPTURE_UNCERTAIN`.
- `DECLINED` or `FAILED`: booking may fail after definitive reconciliation.
- Network timeout or 5xx: outcome is unknown, not failed.

## F.2 Order and hold clocks

- Local quote/hold TTL remains authoritative for slot allocation.
- PayPal Orders v2 order lifetime is a separate clock.
- Default PayPal order lifetime is approximately three hours.
- Local hold expiry shall be checked before capture.
- If local hold expired before capture starts, do not capture.
- If capture occurred despite local failure, enter compensation and refund exactly once.

## F.3 Provider operation journal

Before every PayPal mutation, persist:

- Internal operation ID.
- Tenant and booking IDs.
- Operation type.
- Provider endpoint.
- Stable `PayPal-Request-Id`.
- Exact canonical payload hash.
- Attempt count and timestamps.
- Provider resource IDs when known.
- State.

Provider-operation states shall include:

- `PREPARED`
- `DISPATCHING`
- `SENT_UNKNOWN`
- `PENDING`
- `SUCCEEDED`
- `FAILED_TERMINAL`
- `RECONCILING`
- `MANUAL_REVIEW`

## F.4 PayPal request IDs

- Create, capture, refund, and invoice operations shall use distinct request IDs.
- The request ID and payload hash shall be committed before dispatch.
- Automated retries shall reuse the identical endpoint, payload, and request ID.
- Concurrent attempts with the same PayPal request ID are prohibited.
- Use six hours as the conservative automated retry window for Orders/Payments v2.
- After the retention window, query authoritative PayPal state rather than issuing a new mutation for an unknown prior outcome.

## F.5 Unknown capture outcome

On timeout or 5xx after dispatch:

1. Set provider operation to `SENT_UNKNOWN`.
2. Keep resource claims blocking.
3. Return `202` and an operation-status URL.
4. Retry with the same request ID inside the provider window.
5. Fetch the PayPal order and inspect capture resources.
6. Consume verified capture webhooks.
7. Converge to one confirmed booking or one compensating refund/void.

Never infer provider failure from an HTTP timeout.

## F.6 Refund serialization

Refund commands shall serialize per capture.

Under a capture row lock:

```text
requested refund
<= captured amount
 - completed refunds
 - pending refunds
 - unknown refunds
```

Each logical refund shall have:

- Immutable internal refund ID.
- Stable PayPal request ID.
- Explicit amount and currency.
- Original capture destination.
- Authorization/audit evidence.

Omitting refund amount is prohibited.

## F.7 Ledger authority

The internal append-only journal is authoritative.

PayPal Invoicing is a customer-facing projection.

The system shall not:

- Use invoice balance as proof of captured funds.
- Use Invoicing record-payment to represent a PayPal Orders capture as canonical truth.
- Use Invoicing record-refund to execute a PayPal refund.

PayPal-processed refunds shall use Payments v2.

---

# G. Webhook Ingestion and Reconciliation

## G.1 Ingress

Webhook ingress shall:

1. Enforce HTTPS, content type, body limit, and burst controls.
2. Preserve exact raw bytes and PayPal transmission headers.
3. Store the delivery durably in an untrusted/quarantine inbox.
4. Return 2xx only after durable receipt.
5. Verify asynchronously with bounded retries.

No business transition may occur before successful verification.

## G.2 Verification and deduplication

After verification:

- Deduplicate on `(environment, provider_connection_id, provider_event_id)`.
- Record transmission IDs for diagnostics/replay analysis.
- Verify webhook/app ID.
- Verify environment.
- Verify merchant/payee.
- Verify amount and currency.
- Verify resource IDs.
- Verify opaque booking/provider-operation mapping.

Do not reserve a provider event ID before verification, because an attacker could submit a guessed ID first.

## G.3 Ordering

PayPal webhooks are at-least-once and may arrive out of order.

Workers shall:

1. Validate whether a transition is legal.
2. Fetch current PayPal resource state for material or ambiguous transitions.
3. Apply the current authoritative state idempotently.
4. Ignore events older than already reconciled provider state.

Do not reconstruct truth by replaying webhook arrival order.

## G.4 Simulator limitation

PayPal Webhooks Simulator:

- Is suitable for ingress and handler-shape testing.
- Does not represent a real app transaction.
- Uses synthetic resource IDs.
- Does not validate complete resource reconciliation.
- Does not support the ordinary verification postback path for mock events.

At least one end-to-end test shall use:

- A real sandbox order.
- The same sandbox REST app that owns the webhook.
- A real capture.
- A real received and verified webhook.

---

# H. Durable Outbox and BullMQ

## H.1 Hackathon decision

PostgreSQL polling may remain the primary worker transport through the hackathon if it meets required throughput.

BullMQ migration is optional and shall not block submission.

## H.2 Source of truth

The PostgreSQL outbox remains authoritative.

Redis/BullMQ shall not become the only durable record of intended work.

## H.3 Relay lease

Multiple relay replicas shall:

1. Claim ready rows with `FOR UPDATE SKIP LOCKED`.
2. Write a random lease token and lease expiry.
3. Commit.
4. Enqueue outside the database transaction.
5. Use a deterministic BullMQ `jobId` derived from event ID.
6. Mark enqueued only when the same lease token still owns the row.
7. Allow another relay to reclaim expired leases.

A stale relay shall update zero rows after another replica reclaims the event.

## H.4 Delivery guarantee

The supported guarantee is:

```text
at-least-once execution + effect-once idempotent consumer
```

BullMQ job IDs are not permanent deduplication.

Every consumer shall insert `event_id` into a PostgreSQL inbox in the same transaction as its durable side effect.

For strict end-to-end at-least-once delivery, the outbox shall remain replayable until the consumer writes a durable PostgreSQL receipt.

## H.5 Event versioning

Every outbox event shall include:

- Event ID.
- Tenant ID.
- Aggregate type and ID.
- Aggregate version.
- Event type.
- Schema version.
- Immutable payload.
- Creation timestamp.

Consumers shall detect version gaps and defer/reconcile them rather than assuming completion order.

---

# I. Additional Required Abuse Tests

Add these scenarios to the existing Abuse Lab:

1. Intent A combined with Confirmation B.
2. One confirmation reused sequentially with a new idempotency key.
3. One hundred simultaneous commits with one confirmation.
4. Actor, OAuth client, and tenant substituted independently.
5. Intent replayed through a transport not listed in `allowed_surfaces`.
6. Tool name/version/schema changed after prepare.
7. Duplicate JSON keys.
8. Unicode NFC/NFD canonicalization differences.
9. Exponent notation, excessive precision, negative and overflow money.
10. Zero-decimal and three-decimal currency mismatch.
11. Commit at `exp - 1`, exactly `exp`, and after `exp`.
12. `alg:none`, algorithm confusion, unknown `kid`, remote `jku`, and wrong `typ`.
13. Buyer A shares approval URL with Buyer B.
14. Role or tenant membership revoked after approval.
15. MCP `action: accept` without browser approval completion.
16. Crash after confirmation consumption.
17. Crash after outbox insertion.
18. PayPal succeeds before local persistence.
19. Cancellation/expiry/commit race.
20. Long transaction starts before expiry and attempts commit after expiry.
21. RLS context leak through a one-connection pool.
22. Outbox relay resumes after its lease was reassigned.
23. BullMQ worker executes a stalled job twice.
24. PayPal simulator event sent to the production webhook route.
25. Refund performed externally in PayPal dashboard.
26. Webhook certificate URL targets a redirect, private address, or non-PayPal host.
27. Order reports `COMPLETED` while capture reports `PENDING`.
28. Wrong sandbox app or wrong environment webhook.

Critical and High scenarios shall have a 100% deterministic pass rate.

Model refusal alone is not a passing security assertion.

---

# J. Judge Mode and Demo Requirements

## J.1 Isolated judge tenant

Judge reset shall:

- Operate only on a dedicated synthetic tenant.
- Use a unique run ID.
- Seed deterministic services, resources, bookings, forecasts, and attack cases.
- Never delete or mutate another tenant.
- Create fresh PayPal sandbox orders when external resources are required.
- Report reset progress and failures.

Do not claim that PayPal sandbox transactions were deleted when they were not.

## J.2 Bryntum usage

Bryntum shall be an operational surface, not decoration.

Use:

- Resources for providers/staff.
- Events for appointments.
- Assignments for resource links.
- ResourceTimeRanges for forecast probability bands behind events.
- Payment/risk state in event rendering.
- Explicit legend and accessible non-color indicators.
- Drag/reschedule through normal backend commands.
- Optimistic rollback on `409`.

## J.3 Technical proof panel

The judge-facing trace may display:

- Opaque booking ID.
- Intent hash.
- Confirmation consumed state.
- Idempotency key hash.
- PayPal order and capture IDs.
- Capture status.
- Webhook verification state.
- Resource-claim state.
- Reconciliation result.

Do not display secrets, access tokens, customer notes, or PII.

## J.4 Required demo path

The hosted demonstration shall show:

1. AI-assisted service/slot discovery.
2. Forecast-bounded deposit.
3. Explicit buyer terms approval.
4. PayPal sandbox approval and capture.
5. Verified webhook confirmation.
6. Bryntum schedule update.
7. Slot-hoarding and prompt-injection attempts blocked.
8. Injected capture-response loss reconciled to one payment and one booking.
9. A weak slot surfaced by the fill forecast.
10. Waitlist or targeted action improving the schedule.

---

# K. Updated Acceptance Gates

## K.1 Epic 2 completion

Epic 2 is complete only when:

1. One hundred concurrent fixed-slot holds create exactly one blocking claim.
2. Independent tenants/resources do not block one another.
3. Boundary and DST range tests pass.
4. Confirm/expire/replacement-hold races produce one legal winner.
5. Long-transaction expiry test fails closed.
6. Hold reapers recover after replica termination.
7. RLS pool-leak tests pass.
8. Signed intent and one-time confirmation mix-and-match tests pass.
9. Commit creates one `COMMITTING` operation and one outbox event.
10. No network call occurs inside the commit transaction.

## K.2 Epic 3 completion

Epic 3 is complete only when:

1. A real sandbox CAPTURE order completes.
2. Booking confirmation depends on capture `COMPLETED`.
3. Pending capture does not confirm booking.
4. Response-loss injection reconciles without duplicate capture.
5. Real sandbox webhook verification succeeds.
6. Duplicate and out-of-order events converge idempotently.
7. Concurrent refunds cannot exceed captured value.
8. External/dashboard refund is detected by reconciliation.
9. Internal journals balance per currency.
10. Invoicing projection failure does not alter canonical payment state.

---

# L. Release Gates

The project shall not claim production readiness until:

1. Real PostgreSQL 17 migrations apply and roll back.
2. Concurrency tests run against real PostgreSQL, not mocks.
3. RLS pool-isolation tests pass.
4. Provider operations and unknown outcomes are durable.
5. Refunds serialize per capture.
6. Raw webhook verification and durable deduplication pass.
7. Daily/report reconciliation strategy is implemented or explicitly documented as pre-production work.
8. Consumer inbox deduplication protects every durable side effect.
9. One-time buyer confirmation is separate from signed-intent integrity.
10. All Critical and High Abuse Lab scenarios pass.

---

# M. Additional Official References

- PayPal order status: https://developer.paypal.com/api/orders/v2/definitions/order_status
- PayPal capture status: https://developer.paypal.com/api/orders/v2/definitions/capture
- PayPal Orders flow: https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/standard
- PayPal idempotency: https://developer.paypal.com/api/rest/reference/idempotency/
- PayPal webhooks: https://developer.paypal.com/api/rest/webhooks/rest
- PayPal refund endpoint: https://developer.paypal.com/api/payments/v2/captures-refund
- PostgreSQL range constraints: https://www.postgresql.org/docs/17/rangetypes.html
- PostgreSQL RLS: https://www.postgresql.org/docs/17/ddl-rowsecurity.html
- PostgreSQL partial indexes: https://www.postgresql.org/docs/17/indexes-partial.html
- PostgreSQL locking: https://www.postgresql.org/docs/17/explicit-locking.html
- MCP Streamable HTTP 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- MCP authorization security: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- WebMCP draft: https://webmachinelearning.github.io/webmcp/
- OWASP Agentic Top 10 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/
- Bryntum ResourceTimeRanges: https://bryntum.com/products/scheduler/docs-llm/api/Scheduler/feature/ResourceTimeRanges.md
