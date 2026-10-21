Act as the Principal Payment Systems Reviewer and Implementation Engineer for velvetAI.

This is an Epic 3 acceptance audit and remediation pass.

Do not begin Epic 4.
Do not add live PayPal support.
Do not implement Vault, Subscriptions, Payouts, multiparty onboarding, MCP execution, WebMCP execution, BullMQ migration, or unrelated features.

READ FIRST

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. @docs/decisions/0005-concurrency-safe-booking-and-signed-intents.md
5. @docs/decisions/0006-paypal-payment-finality-and-reconciliation.md
6. Existing Epic 3 migrations, payment services, PayPal adapter, webhook routes, web component, and tests

SOURCE PRECEDENCE

- SPEC_V1_1_AMENDMENT.md supersedes conflicts in spec.md.
- The current code is not authoritative when it conflicts with either specification.
- Record every remediation and deviation in docs/implementation-progress.md.

==================================================
1. CAPTURE-STATE SEMANTICS
==================================================

Audit and correct every capture transition.

Required behavior:

- Capture COMPLETED:
  - Persist capture.
  - Post journal.
  - Confirm booking.

- Capture PENDING:
  - Do not mark payment failed.
  - Move payment/booking to CAPTURE_UNCERTAIN or provider-pending equivalent.
  - Keep resource claim blocking.
  - Schedule reconciliation.

- Capture DECLINED or FAILED:
  - Treat as terminal only when PayPal authoritatively reports that state.
  - Transition to PAYMENT_FAILED, not PAYMENT_WINDOW_EXPIRED.
  - Release claim only after definitive failure.

- Timeout, connection reset, or HTTP 5xx:
  - Outcome is unknown.
  - Keep refund/payment reservation and slot claim blocking.
  - Reconcile before release.

PAYMENT_WINDOW_EXPIRED shall only represent expiration before capture dispatch.

Add a distinct PAYMENT_FAILED state where needed.

Required tests:

1. Order COMPLETED plus capture PENDING does not confirm or fail booking.
2. Capture PENDING later becomes COMPLETED and confirms once.
3. Capture PENDING later becomes DECLINED and releases once.
4. Definitive failure before payment-window expiry uses PAYMENT_FAILED.
5. Timeout never maps directly to FAILED or releases a claim.

==================================================
2. WEBHOOK QUARANTINE POISONING
==================================================

Unverified events must not reserve the canonical provider event ID.

Required design:

1. webhook_quarantine stores unverified deliveries keyed by an internal delivery ID and transmission metadata.
2. It may index payload digest for diagnostics, but an invalid delivery must not suppress a later valid delivery.
3. provider_event_id uniqueness belongs only in verified_provider_events after successful signature verification.
4. Do not return deduplicated success based on an unverified provider event ID.
5. Verify first, then atomically insert the verified event ID.
6. A forged event with a guessed event ID followed by the legitimate signed event must allow the legitimate event to process.

Required tests:

- Invalid signature with event ID X, then valid signature with event ID X.
- Invalid duplicate deliveries do not create verified deduplication rows.
- Two valid deliveries of event ID X create one verified event and one business effect.
- Same body digest with different valid transmission IDs remains diagnostically visible.
- Wrong app, webhook ID, environment, merchant, or provider connection cannot reserve event identity.

==================================================
3. OUT-OF-ORDER WEBHOOK RECONCILIATION
==================================================

Webhook handlers shall not directly trust arrival order.

For material events:

1. Verify the event.
2. Resolve the mapped provider operation.
3. Fetch current PayPal order/capture/refund state.
4. Apply the current authoritative provider state through an idempotent reducer.

Add evidence for:

- REFUNDED event arriving before locally observed CAPTURE.COMPLETED.
- Duplicate PENDING after COMPLETED.
- Delayed APPROVED after capture.
- External dashboard refund.
- Approval-reversed event.

Support or explicitly handle:

- CHECKOUT.ORDER.APPROVED
- CHECKOUT.PAYMENT-APPROVAL.REVERSED
- PAYMENT.CAPTURE.PENDING
- PAYMENT.CAPTURE.COMPLETED
- PAYMENT.CAPTURE.DENIED and/or the event actually exposed by the sandbox app
- PAYMENT.CAPTURE.REFUNDED

Query or record the event types supported by the configured sandbox REST app.

==================================================
4. REFUND UNKNOWN OUTCOMES
==================================================

Audit refund error mapping.

Required behavior:

- Definitive PayPal rejection:
  - Reservation may move to FAILED and release refundable capacity.

- Timeout, connection reset, 409 previous request in progress, or HTTP 5xx:
  - Reservation moves to UNKNOWN or RECONCILING.
  - Refund capacity remains reserved.
  - Retry uses the same request ID and identical payload within the supported window.
  - After the provider window, query PayPal state rather than creating a new refund.

Required tests:

1. Refund succeeds but response is dropped.
2. Refund returns 5xx after provider effect.
3. Two reconciliation workers process the same unknown refund.
4. Unknown refund plus a new refund request cannot over-refund.
5. External refund reduces local refundable balance after reconciliation.

==================================================
5. PAYPAL JAVASCRIPT SDK V6 PROOF
==================================================

Verify the web component uses PayPal JS SDK v6 rather than the legacy v5 pattern.

Required evidence:

- Loads the official v6 core script:
  https://www.paypal.com/web-sdk/v6/core
- Uses the current v6 initialization/session APIs from official PayPal documentation.
- Does not load:
  https://www.paypal.com/sdk/js?client-id=...
- Does not use legacy paypal.Buttons(...).render(...) unless PayPal's current v6 documentation explicitly requires a compatibility path.
- Client ID is public; client secret never reaches the browser.
- create-order callback obtains the server-created order ID.
- onApprove only invokes the velvetAI backend capture endpoint.
- UI waits for authoritative server state.

Add a component test asserting the loaded script URL and the absence of legacy API usage.

Do not invent SDK method names. Cite the exact official v6 page used by the implementation.

==================================================
6. REAL PAYPAL SANDBOX END-TO-END EVIDENCE
==================================================

Epic 3 is not complete without an opt-in real sandbox test.

Required environment:

- PAYPAL_ENVIRONMENT=sandbox
- PAYPAL_CLIENT_ID
- PAYPAL_CLIENT_SECRET
- PAYPAL_WEBHOOK_ID
- PAYPAL_JS_CLIENT_ID
- RUN_PAYPAL_SANDBOX_E2E=1

Credentials must remain untracked and redacted.

Required real-sandbox flow:

1. Create a fresh PayPal sandbox order through velvetAI.
2. Approve with a sandbox buyer.
3. Capture through the velvetAI backend.
4. Confirm the capture status is COMPLETED.
5. Receive a webhook from the same sandbox REST app.
6. Verify the real webhook signature.
7. Confirm one booking and one balanced journal entry.
8. Issue an explicit partial refund.
9. Reconcile refund state/webhook.
10. Prove no duplicate capture or refund exists.

If credentials, public webhook ingress, or manual buyer approval are unavailable:

- Mark the test BLOCKED or NOT_RUN.
- Do not claim Epic 3 fully verified.
- Keep the automated fake-provider tests, but distinguish them clearly.

Record sanitized IDs, timestamps, statuses, and test output. Do not record credentials or payer PII.

==================================================
7. FINANCIAL JOURNAL DATABASE INTEGRITY
==================================================

Application-only balancing is insufficient for a production-grade claim.

Required behavior:

1. Journal entries have DRAFT and POSTED lifecycle or are inserted atomically through one controlled posting operation.
2. Balance is validated before POSTED.
3. No lines may be added after POSTED.
4. UPDATE and DELETE attempts on posted entries/lines raise an error.
5. Do not silently ignore update/delete with DO INSTEAD NOTHING.
6. Runtime roles lack direct mutation privileges outside the posting path where practical.
7. Reversals create new entries.

Replace silent rewrite-rule protection with explicit exception-raising triggers or an equivalently strict mechanism.

Required tests:

- Unbalanced entry cannot post.
- Adding a line after posting fails.
- Updating a posted line fails visibly.
- Deleting a posted line/entry fails visibly.
- Balanced capture and refund entries post once.
- Replay creates no duplicate journal.

Review capture accounting:

- Gross capture.
- PayPal fee when present in seller_receivable_breakdown.
- Net clearing.
- Customer-deposit liability.

Do not claim legal/accounting certification.

==================================================
8. MONEY AND CURRENCY SUPPORT
==================================================

Declare the MVP supported currency allowlist explicitly.

If the hackathon uses USD only:

- Reject all other currencies in the booking/payment path.
- Keep generic conversion utilities tested separately.

If multiple currencies are accepted:

- Use a maintained ISO-4217 source or a reviewed complete allowlist.
- Do not default unknown currencies to two decimal places.
- Validate PayPal's supported currency list separately from ISO-4217.

Required tests:

- Unsupported currency fails before order creation.
- Zero-, two-, and three-decimal conversion where supported.
- Decimal string round-trip.
- Overflow and precision errors.

==================================================
9. RLS SETTING CONSISTENCY
==================================================

The report references app.current_tenant_id while prior requirements used app.tenant_id.

Choose one canonical custom setting and use it consistently in:

- withTenantTransaction
- Every RLS policy
- Tests
- Documentation
- Worker code

Add a test that inspects policy definitions and proves the helper sets the same key.

==================================================
10. EXACT VERIFICATION EVIDENCE
==================================================

Run and record exact commands separately:

- pnpm install --frozen-lockfile
- pnpm lint
- pnpm typecheck
- pnpm test
- pnpm build
- git diff --check
- git status --short

Fix the four lint warnings or record exact technical justification.

The final report shall state:

- Exact command for build.
- Fake-provider test results.
- Real-sandbox test result separately.
- Skipped tests and reasons.
- Current branch and commit.

Correct documentation drift:

- Epic 4 is Agent Interfaces and Security Boundary.
- Staff/calendar synchronization is not the definition of Epic 4.

==================================================
DEFINITION OF DONE
==================================================

Epic 3 is accepted only when:

1. Capture PENDING remains uncertain and blocking.
2. Terminal payment failure is distinct from payment-window expiry.
3. Unverified webhook event IDs cannot poison verified deduplication.
4. Out-of-order webhooks fetch authoritative provider state.
5. Unknown refunds retain their reservation.
6. PayPal JS SDK v6 usage is proven.
7. A real opt-in sandbox create/approve/capture/webhook/refund flow passes, or Epic 3 is explicitly marked blocked/not fully verified.
8. Journal integrity is enforced at the database boundary without silent mutation success.
9. Supported currencies are explicit.
10. RLS setting names are consistent.
11. Lint, typecheck, tests, build, migration lifecycle, and diff checks pass.
12. docs/implementation-progress.md contains exact evidence.

Stop after this audit.
Do not begin Epic 4.