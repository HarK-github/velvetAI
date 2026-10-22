Act as the Lead Payment Systems Engineer and Security-Conscious Implementation Engineer for velvetAI.

Repository root: current working directory
Environment: macOS, Zsh
Runtime manager: mise
Package manager: pnpm
Database: PostgreSQL 17+
Payment environment: PayPal Sandbox only

READ THESE FILES COMPLETELY BEFORE CHANGING CODE

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. @docs/decisions/0005-concurrency-safe-booking-and-signed-intents.md
5. Existing payment-related code and tests

SOURCE-OF-TRUTH ORDER

- SPEC_V1_1_AMENDMENT.md supersedes conflicting requirements in spec.md.
- spec.md remains authoritative where not amended.
- Existing code is not authoritative when it conflicts with either specification.
- Record every necessary deviation in docs/implementation-progress.md and an ADR.

CURRENT ACCEPTED STATE

Sprint Epic 2 is accepted as complete after remediation:

- Persisted GiST blocking state and integrity constraint.
- PostgreSQL RLS under a restricted NOBYPASSRLS runtime role.
- Concurrency-safe quote and hold creation.
- ES256 signed booking intents.
- Separate one-time buyer confirmation.
- Atomic COMMITTING transition and outbox event.
- Concurrent replay, tenant isolation, canonicalization, money serialization, migration lifecycle, and Abuse Lab tests.

No PayPal side effects have been implemented.

PRIMARY OBJECTIVE

Implement Sprint Epic 3:

1. PayPal Sandbox Orders v2 deposit order creation.
2. Buyer approval through PayPal JavaScript SDK v6.
3. Backend capture.
4. Unknown-outcome reconciliation.
5. Payments v2 refunds.
6. Raw webhook ingestion, signature verification, deduplication, and reconciliation.
7. Internal provider-operation journal and balanced financial journal.
8. PayPal Invoicing v2 balance projection after appointment completion.

Do not implement Vault, Subscriptions, Payouts, multiparty onboarding, live payments, MCP execution, WebMCP execution, or BullMQ migration.

==================================================
MANDATORY PRE-FLIGHT GATE
==================================================

Before any PayPal side effect:

1. Run and record:
   - git status --short
   - pnpm install --frozen-lockfile
   - pnpm lint
   - pnpm typecheck
   - pnpm test
   - pnpm build
2. Confirm docs/implementation-progress.md is canonical.
3. Confirm archived specifications are clearly marked DO NOT USE.
4. Confirm duplicate progress files are absent.
5. Confirm confirmation-token replay with different idempotency keys passes.
6. Confirm duplicate JSON keys are rejected through a real HTTP request.
7. Confirm RLS tests run under the restricted runtime role.
8. Confirm the repository contains no production PayPal credentials.

If the baseline fails, stop PayPal work and repair or report the blocker.

JWS SIMPLIFICATION

Use the maintained jose library as the authoritative JWS signing and verification implementation.

Node crypto may remain for:

- crypto.randomBytes
- crypto.timingSafeEqual
- SHA-256 hashing
- explicit interoperability tests

Do not maintain a second production JWS signing/verification path through crypto.sign or crypto.verify unless a benchmark and ADR justify it.

==================================================
PAYMENT STATE MACHINE
==================================================

Implement this state progression:

COMMITTING
→ ORDER_CREATE_PENDING
→ REQUIRES_PAYER_ACTION
→ CAPTURE_IN_FLIGHT
→ CAPTURED
→ CONFIRMED

Alternative transitions:

ORDER_CREATE_PENDING
→ ORDER_CREATE_UNKNOWN
→ REQUIRES_PAYER_ACTION or PAYMENT_FAILED or MANUAL_REVIEW

REQUIRES_PAYER_ACTION
→ PAYMENT_WINDOW_EXPIRED

CAPTURE_IN_FLIGHT
→ CAPTURE_UNCERTAIN
→ CAPTURED or PAYMENT_FAILED or MANUAL_REVIEW

CAPTURED
→ REFUND_PENDING
→ PARTIALLY_REFUNDED or REFUNDED

Rules:

- PayPal order APPROVED does not confirm the velvetAI booking.
- PayPal order COMPLETED does not by itself confirm the booking.
- Booking confirmation requires a contained capture with status COMPLETED.
- Capture PENDING keeps the booking in CAPTURE_UNCERTAIN.
- Timeout and HTTP 5xx mean unknown outcome, not failure.
- Client onApprove is a trigger to call the velvetAI capture endpoint, not proof of payment.

==================================================
PAYMENT WINDOW AND SLOT-HOARDING CONTROL
==================================================

The existing short hold becomes COMMITTING after velvetAI buyer confirmation.

Add a fixed payment_expires_at:

- Set when the confirmation is consumed.
- Default to ten minutes unless existing product configuration defines a stricter approved value.
- Do not extend it through polling, retries, page refresh, or repeated create-order requests.
- Keep the resource claim blocking through the payment window.

If payment_expires_at elapses before capture dispatch:

1. Transition to PAYMENT_WINDOW_EXPIRED.
2. Release the resource claim.
3. Do not capture a later buyer approval.

If capture was already dispatched or its outcome is unknown:

1. Keep the resource claim blocking.
2. Reconcile first.
3. Confirm or compensate exactly once.

The PayPal order lifetime and velvetAI payment window are separate clocks. The shorter velvetAI payment window remains authoritative for slot allocation.

==================================================
WORK PHASES
==================================================

W0 — Audit and Architecture Plan

1. Inspect current booking, outbox, adapter, and state-machine code.
2. Map every new state and transition.
3. Produce a short implementation checklist.
4. Create ADR 0006 for PayPal payment finality and reconciliation.
5. Update docs/implementation-progress.md before implementation.

W1 — Persistence and Domain Model

Create or complete migrations and Kysely types for:

1. provider_connections
2. provider_operations
3. payment_intents
4. payment_captures
5. refund_reservations/refunds
6. webhook_deliveries
7. verified_provider_events
8. financial_journal_entries
9. financial_journal_lines
10. invoices

provider_operations shall store:

- id
- tenant_id
- booking_id
- provider
- environment
- operation_type
- state
- endpoint
- paypal_request_id
- canonical_payload_hash
- provider_order_id
- provider_capture_id
- provider_refund_id
- attempt_count
- first_dispatched_at
- last_attempt_at
- next_reconcile_at
- last_http_status
- provider_debug_id
- error_code
- created_at
- updated_at

Required provider-operation states:

- PREPARED
- DISPATCHING
- SENT_UNKNOWN
- PENDING
- SUCCEEDED
- FAILED_TERMINAL
- RECONCILING
- MANUAL_REVIEW

Required uniqueness:

- tenant_id + paypal_request_id + operation_type
- provider connection + provider order ID
- provider connection + provider capture ID
- provider connection + provider refund ID

All money columns remain bigint minor units.

Wire/API money remains a validated decimal string.

Add payment_expires_at to the appropriate booking/payment record.

Financial journal rules:

- Append-only.
- Integer minor units.
- Balanced per journal entry and currency.
- Corrections use reversing entries.
- Invoicing is not the canonical ledger.

W2 — PayPal Sandbox Client

Implement a typed PayPal adapter behind PaymentPort.

Requirements:

1. Hard-code no production URL.
2. Select base URL only from validated environment enum.
3. Epic 3 shall refuse startup when PAYPAL_ENVIRONMENT is not sandbox.
4. Obtain OAuth access tokens through client credentials.
5. Cache token until provider expiry minus 60 seconds.
6. Serialize token refresh to avoid stampede.
7. Never log Authorization headers, client secret, access token, payer email, customer notes, or raw approval data.
8. Capture PayPal debug_id and normalized errors.
9. Apply explicit connect, headers, response, and total timeouts.
10. Use a typed error taxonomy:
    - definitive client failure
    - retryable transport/server failure
    - unknown mutation outcome
    - authentication/configuration failure

Implement:

- createOrder
- getOrder
- captureOrder
- getCapture
- refundCapture
- getRefund
- verifyWebhookSignature
- createInvoiceDraft
- sendInvoice
- getInvoice

Do not expose generic arbitrary PayPal requests.

W3 — Create Deposit Order

Endpoint:

POST /v1/bookings/{bookingId}/payment-order

Input:

- No amount.
- No currency.
- No payee.
- No tenant ID.
- Idempotency-Key header only.

Server behavior:

1. Derive tenant and actor from authentication.
2. Lock booking/payment state.
3. Require COMMITTING or idempotent existing operation.
4. Require payment_expires_at to be in the future.
5. Read merchant, deposit minor units, currency, service and policy from the immutable snapshot.
6. Create and commit provider operation with stable PayPal-Request-Id and payload hash.
7. Commit before calling PayPal.
8. Create an Orders v2 order with intent CAPTURE.
9. Use one purchase unit.
10. Use an opaque booking reference in custom_id.
11. Include no PII in custom_id, invoice_id, description, or metadata.
12. Omit client-controlled payee data.
13. Persist PayPal order ID and response state.
14. Transition to REQUIRES_PAYER_ACTION.
15. Return the PayPal order ID required by JS SDK v6.

Unknown create-order result:

- Mark ORDER_CREATE_UNKNOWN/SENT_UNKNOWN.
- Retry only with the same request ID and payload inside the documented provider window.
- Reconcile before issuing any new mutation.

W4 — PayPal JavaScript SDK v6

Integrate the official PayPal JS SDK v6 using current PayPal documentation.

Requirements:

1. Client ID may be public; client secret must remain server-only.
2. create-order callback calls velvetAI payment-order endpoint.
3. onApprove calls velvetAI backend capture endpoint.
4. onApprove does not set CONFIRMED locally.
5. UI renders server-returned booking/payment state.
6. Client cannot provide amount, currency, payee, refund value, or booking state.
7. Cancellation/closing PayPal leaves the booking awaiting action until payment_expires_at.
8. Payment-window countdown is visible and derived from server time.
9. Expired payment windows disable capture and offer fresh availability.

Do not invent JS SDK APIs. Verify all integration calls against official JS SDK v6 documentation current on the implementation date.

W5 — Backend Capture and Reconciliation

Endpoint:

POST /v1/payments/{paymentIntentId}/capture

Before provider call:

1. Derive tenant and actor.
2. Lock booking and payment intent.
3. Verify state REQUIRES_PAYER_ACTION or an idempotent existing capture operation.
4. Verify payment_expires_at using database time.
5. Persist capture provider operation and stable PayPal-Request-Id.
6. Transition to CAPTURE_IN_FLIGHT.
7. Commit.

Provider response handling:

- Capture COMPLETED:
  - Persist capture.
  - Append balanced journal.
  - Transition booking to CONFIRMED.
  - Retain resource claim as confirmed.
- Capture PENDING:
  - Transition to CAPTURE_UNCERTAIN.
  - Keep resource claim blocking.
  - Schedule reconciliation.
- Capture DECLINED or FAILED:
  - Persist terminal failure.
  - Release claim only after authoritative failure.
- Timeout, reset, or 5xx:
  - Mark SENT_UNKNOWN/CAPTURE_UNCERTAIN.
  - Return HTTP 202 with operation-status URL.
  - Keep resource claim blocking.

Booking confirmation condition:

purchase_units[].payments.captures[].status == COMPLETED

Do not confirm from:

- Browser onApprove.
- Order APPROVED.
- Order COMPLETED alone.
- Webhook receipt before verification.
- Model/tool output.

Reconciliation worker:

1. Claim due operations safely.
2. Retry identical mutation with same request ID only inside the provider retention window.
3. GET PayPal order and inspect capture collection.
4. GET known capture/refund resources.
5. Consume verified webhooks.
6. Never generate a new request ID solely because the prior outcome is unknown.
7. Move unresolved expired operations to MANUAL_REVIEW.

W6 — Webhook Ingress

Endpoint:

POST /v1/webhooks/paypal/{connectionKey}

Raw body requirements:

- Preserve exact Buffer bytes.
- Do not pass through the normal duplicate-key JSON parser first.
- Implement a route-scoped raw-body mechanism.
- Enforce 256 KiB body limit.
- Store exact bytes and required transmission headers durably.

Ingress sequence:

1. Validate connection key and environment.
2. Store delivery as UNVERIFIED.
3. Return 2xx only after durable storage.
4. Queue verification through the existing PostgreSQL outbox/worker.
5. Verify through PayPal verify-webhook-signature endpoint or a correctly secured self-verifier.
6. Only after successful verification, record provider event ID uniqueness.
7. Reconcile current PayPal resource state.
8. Apply an idempotent legal transition.

Required validation:

- Registered webhook ID.
- Sandbox environment.
- App/provider connection.
- Merchant/payee.
- Amount and currency.
- Order/capture/refund ID.
- Opaque booking/provider-operation mapping.

PayPal events are at-least-once and may arrive out of order.

Do not reconstruct truth from arrival order.

Subscribe/test relevant events:

- CHECKOUT.ORDER.APPROVED
- CHECKOUT.PAYMENT-APPROVAL.REVERSED
- PAYMENT.CAPTURE.PENDING
- PAYMENT.CAPTURE.COMPLETED
- PAYMENT.CAPTURE.DENIED and/or currently supported failure event
- PAYMENT.CAPTURE.REFUNDED
- Relevant refund failure/pending events exposed by the sandbox app

At deployment/test setup, query supported webhook event types rather than assuming conflicting documentation names.

Simulator events:

- Must never be accepted by the production webhook path as proof of a real payment.
- May test ingress shape only.
- Cannot replace a real sandbox end-to-end webhook test.

If self-verifying:

- Allowlist PayPal HTTPS certificate hosts.
- Reject redirects.
- Reject private/link-local addresses.
- Limit response size and timeout.
- Validate certificate lifetime.
- Cache safely.

W7 — Refunds

Endpoint:

POST /v1/captures/{captureId}/refunds

Input:

- Reason code.
- Approved explicit refund amount as decimal minor-unit string only when the route is merchant-authorized.
- Idempotency-Key.

For policy-driven buyer cancellation, calculate refund amount server-side; do not accept it from the buyer or agent.

Under a capture row lock:

requested amount
<= captured amount

- completed refunds
- pending refunds
- unknown refunds

Before provider call:

1. Authorize actor and role.
2. Verify tenant/capture/booking relationship.
3. Create immutable refund reservation.
4. Persist provider operation and stable request ID.
5. Commit.

Use Payments v2 against the original capture.

Never:

- Change refund destination.
- Change currency.
- Omit amount for concurrency-sensitive refunds.
- Treat timeout as failure.
- Allow completed plus pending plus unknown refunds to exceed capture.

Detect externally initiated PayPal refunds through verified webhooks and reconciliation.

W8 — Internal Financial Journal and Invoicing

Canonical truth:

- Orders v2 order/capture records.
- Payments v2 refunds.
- Internal append-only journal.

Invoicing remains a projection.

Required journal behavior:

- Every completed capture writes a balanced entry.
- Every completed refund writes a balanced reversing/refund entry.
- Pending/unknown effects remain pending subledger records.
- Corrections append reversals; never mutate prior entries.
- Every entry balances per currency.

Do not assert jurisdiction-specific accounting compliance. Document that merchant accounting treatment requires review.

Balance invoice:

1. Appointment must be COMPLETED.
2. Calculate balance from immutable service total minus completed captured/refunded amounts.
3. Create PayPal invoice draft.
4. Send through a separate provider operation.
5. Mirror invoice lifecycle without making it booking/payment authority.

Do not:

- Record an Orders capture as an offline invoice payment.
- Use Invoicing record-refund to move PayPal funds.
- Revive a cancelled booking when an invoice is paid.

W9 — Tests and Fault Injection

Default tests shall use a deterministic fake PayPal HTTP server/adapter.

Real sandbox tests shall be opt-in through an explicit environment flag and skipped with a clear reason when credentials are absent.

Required automated tests:

1. Order create uses server snapshot amount/currency and opaque metadata.
2. Client-supplied amount/payee fields are rejected.
3. Stable request ID replay returns one provider order.
4. Different payload under same local/provider key fails.
5. Order APPROVED does not confirm booking.
6. Order COMPLETED with capture PENDING does not confirm booking.
7. Capture COMPLETED confirms exactly once.
8. Capture response loss reconciles to one capture and one booking.
9. Capture failure releases claim only after definitive failure.
10. Payment window expiry prevents capture dispatch.
11. Capture dispatched immediately before expiry remains blocking until reconciliation.
12. Duplicate webhook applies one effect.
13. Out-of-order webhook fetches current provider state.
14. Invalid signature produces no provider-event deduplication reservation or business effect.
15. Wrong webhook ID/app/environment fails.
16. Webhook body exceeds 256 KiB and is rejected.
17. Simulator event cannot confirm payment.
18. Concurrent refunds cannot exceed capture.
19. Refund response loss does not create a duplicate.
20. External refund is reconciled.
21. Financial journal balances.
22. Invoice failure does not change canonical payment state.
23. Secrets and PII do not appear in logs, traces, metadata, or snapshots.

Fault-injection cases:

- Drop connection after PayPal receives create-order request.
- Drop capture response after provider creates capture.
- Return 500 after provider effect.
- Delay webhook.
- Deliver webhook twice.
- Deliver refund event before capture-completed event.
- Crash worker before and after local persistence.

Real sandbox acceptance test:

1. Create a fresh sandbox order.
2. Approve using sandbox buyer.
3. Capture through velvetAI backend.
4. Receive a real webhook from the same REST app.
5. Verify webhook signature.
6. Confirm one booking and one journal entry.
7. Issue a partial refund.
8. Reconcile refund webhook/state.

W10 — Documentation and Handoff

Update:

- docs/implementation-progress.md
- ADR 0006
- README
- OpenAPI
- PayPal sandbox setup guide
- Environment-variable documentation
- Webhook local-development instructions
- Reconciliation runbook

Stop after Epic 3.

==================================================
ENVIRONMENT VARIABLES
==================================================

Document and validate at minimum:

- PAYPAL_ENVIRONMENT=sandbox
- PAYPAL_CLIENT_ID
- PAYPAL_CLIENT_SECRET
- PAYPAL_WEBHOOK_ID
- PAYPAL_API_BASE_URL
- PAYPAL_JS_CLIENT_ID
- RUN_PAYPAL_SANDBOX_E2E

Rules:

- API base URL must be derived from validated environment where possible.
- Reject live PayPal base URL during Epic 3.
- Client secret is server-only.
- JS client ID may be public.
- Never commit real values.
- Add placeholders to .env.example.

==================================================
OUT OF SCOPE
==================================================

Do not implement:

- PayPal live environment.
- Vault.
- Saved no-show charges.
- Subscriptions.
- Payouts.
- Multiparty merchant onboarding.
- BullMQ migration.
- MCP execution.
- WebMCP execution.
- LLM calls.
- Bryntum final UI.
- Judge-mode reset.
- Production accounting certification.

==================================================
DEFINITION OF DONE
==================================================

Epic 3 is complete only when:

1. Existing Epic 2 tests still pass.
2. Payment migrations apply, roll back, and re-apply.
3. Provider operations are persisted before every PayPal mutation.
4. Create and capture use separate stable request IDs.
5. Buyer approval occurs between order creation and capture.
6. Only capture COMPLETED confirms booking.
7. Capture PENDING/unknown keeps the claim blocking.
8. Payment-window expiry prevents late capture dispatch.
9. Raw webhook bytes are stored and verified before business processing.
10. Duplicate and out-of-order webhooks converge correctly.
11. Refund reservations prevent over-refund.
12. External refunds are detectable through reconciliation.
13. Internal journal balances per currency.
14. Invoicing remains non-authoritative.
15. A real opt-in PayPal sandbox end-to-end test passes.
16. pnpm lint passes.
17. pnpm typecheck passes.
18. pnpm test passes.
19. pnpm build passes.
20. git diff --check passes.
21. docs/implementation-progress.md contains exact evidence.
22. No production credentials or live side effects exist.

==================================================
FINAL HANDOFF
==================================================

Report:

1. Work-phase status.
2. Files changed.
3. Schema and migration changes.
4. Payment state machine.
5. PayPal adapter behavior.
6. Webhook verification design.
7. Reconciliation behavior.
8. Refund concurrency guarantees.
9. Journal and invoice behavior.
10. Commands and exact results.
11. Fake-adapter and real-sandbox test evidence.
12. Known limitations.
13. Spec deviations and ADRs.
14. Exact next work for Epic 4.

Do not claim commands or sandbox operations were run when they were not.
Do not hide skipped tests or failing checks.
Do not proceed into Epic 4.
