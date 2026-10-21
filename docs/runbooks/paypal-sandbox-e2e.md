# velvetAI PayPal Sandbox End-to-End Runbook

Purpose: complete the only remaining Sprint Epic 3 acceptance gate using real PayPal Sandbox resources.

## Status terminology

Until this runbook passes, report:

```text
Epic 3 code status: IMPLEMENTED
Automated verification: PASSED
Real PayPal Sandbox E2E: BLOCKED / NOT_RUN
Epic 3 acceptance: CONDITIONAL
```

Do not report Epic 3 as fully VERIFIED until the real-sandbox flow passes.

---

# 1. Safety Rules

1. Use PayPal Sandbox only.
2. Never paste client secrets, access tokens, buyer passwords, webhook signatures, or `.env` contents into an LLM prompt, issue, commit, screenshot, or log.
3. Keep secrets only in untracked local environment files or Render secret variables.
4. Use a dedicated sandbox merchant and sandbox buyer.
5. Use a dedicated staging/judge tenant.
6. Confirm the application rejects:

```text
PAYPAL_ENVIRONMENT=live
PAYPAL_ENVIRONMENT=production
```

7. Never run this flow against a real PayPal buyer or real merchant.
8. Do not automate PayPal buyer credentials through source-controlled Playwright scripts.

---

# 2. Standardize the Test Flag

Use one canonical flag:

```text
RUN_PAYPAL_SANDBOX_E2E=1
```

If the code currently uses:

```text
PAYPAL_SANDBOX_LIVE=true
```

rename it or document it as a temporary deprecated alias. Do not maintain two permanent flags with the same meaning.

The word `LIVE` is misleading for a sandbox-only test.

---

# 3. Create Sandbox Accounts

Open:

https://developer.paypal.com/dashboard/

Create or verify:

1. One sandbox business/merchant account.
2. One sandbox personal/buyer account.
3. One REST application owned by the sandbox merchant.

Record securely:

- Sandbox merchant email.
- Sandbox buyer email.
- Sandbox buyer password.
- REST app client ID.
- REST app client secret.

Do not place passwords in repository files.

The REST application used to create orders must also own the registered webhook.

---

# 4. Configure Local Secrets

Use the environment-file location documented by the repository.

Example names:

```text
PAYPAL_ENVIRONMENT=sandbox
PAYPAL_CLIENT_ID=<sandbox app client id>
PAYPAL_CLIENT_SECRET=<sandbox app secret>
PAYPAL_WEBHOOK_ID=<registered sandbox webhook id>
VITE_PAYPAL_CLIENT_ID=<same public sandbox client id>
RUN_PAYPAL_SANDBOX_E2E=1
```

Rules:

- Derive the API base URL from `PAYPAL_ENVIRONMENT`.
- Do not permit an arbitrary production base URL.
- `VITE_PAYPAL_CLIENT_ID` is public.
- `PAYPAL_CLIENT_SECRET` is server-only.
- Do not expose the secret through a `VITE_` variable.

Confirm the file is ignored:

```zsh
git check-ignore PATH_TO_ENV_FILE
```

Do not continue if Git does not ignore it.

---

# 5. Provide Public HTTPS Webhook Ingress

PayPal cannot deliver webhooks directly to localhost.

## Preferred option: Render staging

Deploy a staging API service on Render with:

- Sandbox-only environment enforcement.
- A separate staging database.
- A dedicated judge/staging tenant.
- Secrets entered through Render secret/environment settings.
- HTTPS endpoint such as:

```text
https://YOUR-STAGING-API.onrender.com/v1/webhooks/paypal/PUBLIC_CONNECTION_KEY
```

Do not include a secret credential directly in the connection key. It should be an opaque lookup identifier with separate signature verification.

## Temporary local alternative

Use a reputable HTTPS tunnel only for development. If using one:

- Add the tool to the machine Brewfile.
- Do not expose database, Redis, debug, metrics, or administrative ports.
- Expose only the API HTTP port.
- Treat every tunnel URL as temporary.
- Remove or disable the webhook after testing.

Render is preferred because it also advances the hackathon deployment requirement.

---

# 6. Register the Webhook

Register the public HTTPS endpoint under the same sandbox REST app used for Orders v2.

Subscribe to the events exposed by that sandbox app, including:

```text
CHECKOUT.ORDER.APPROVED
CHECKOUT.PAYMENT-APPROVAL.REVERSED
PAYMENT.CAPTURE.PENDING
PAYMENT.CAPTURE.COMPLETED
PAYMENT.CAPTURE.DENIED
PAYMENT.CAPTURE.REFUNDED
```

Query available webhook event types if PayPal exposes a different failure event name.

Record the generated webhook ID in:

```text
PAYPAL_WEBHOOK_ID
```

Do not use the client ID in place of the webhook ID.

---

# 7. Preflight Verification

From the repository root:

```zsh
git status --short
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected:

- No unreviewed source changes.
- All automated checks pass.
- Placeholder PayPal credentials are no longer active in the running staging environment.
- Production/live environment remains rejected.

Confirm no secret is tracked:

```zsh
git grep -n "PAYPAL_CLIENT_SECRET"
git grep -n "placeholder_paypal"
```

References in `.env.example`, validation messages, tests, and documentation may be legitimate. Actual secret values must not appear.

---

# 8. Start the Real Sandbox Test

Use the repository's documented command. The preferred convention is:

```zsh
RUN_PAYPAL_SANDBOX_E2E=1 pnpm test:sandbox:e2e
```

If the test requires manual buyer approval, it should:

1. Create a real sandbox order through velvetAI.
2. Print or display an approval URL/order ID without exposing credentials.
3. Pause or poll while the tester completes PayPal approval manually.
4. Continue capture and reconciliation after approval.

Do not falsely simulate manual approval when claiming a real E2E pass.

---

# 9. Manual Buyer Approval

Open the velvetAI staging web application.

1. Use the dedicated judge/staging tenant.
2. Choose the seeded USD service.
3. Prepare the booking.
4. Approve velvetAI's immutable service, slot, deposit, currency, merchant, and cancellation terms.
5. Start PayPal checkout.
6. Sign in with the sandbox buyer account.
7. Approve the sandbox payment.

Expected:

- The PayPal JS SDK v6 sandbox UI opens.
- `onApprove` calls the velvetAI backend.
- Browser state does not mark the booking confirmed independently.
- Backend capture determines finality.

---

# 10. Capture Assertions

Confirm:

1. One provider order exists.
2. One capture operation exists.
3. Capture status is `COMPLETED`.
4. Booking status becomes `CONFIRMED`.
5. Resource claim remains blocking as confirmed.
6. Exactly one balanced deposit-capture journal entry exists.
7. No duplicate capture exists.
8. The PayPal order/capture IDs are stored.
9. `PayPal-Request-Id` is stored but secrets are not.
10. Logs contain no buyer email, buyer password, client secret, access token, or customer note.

An order status of `COMPLETED` alone is not sufficient evidence. Record the contained capture status.

---

# 11. Real Webhook Assertions

Wait for PayPal to deliver the webhook.

Confirm:

1. Delivery arrived through the registered public HTTPS endpoint.
2. Exact raw bytes and transmission headers were quarantined.
3. Signature verification returned success.
4. The event moved to `verified_provider_events`.
5. Provider event ID uniqueness was applied only after verification.
6. Duplicate delivery caused no duplicate booking or ledger entry.
7. The webhook belonged to the same sandbox app and environment.
8. Current PayPal resource state was fetched/reconciled where required.

Record sanitized:

- Event type.
- Event ID suffix or redacted ID.
- Verification result.
- Received/processed timestamps.
- Booking state.

Do not store the complete signed payload in public documentation.

---

# 12. Partial Refund Test

Issue an explicit partial refund smaller than the captured deposit.

Confirm:

1. Refund amount was calculated/authorized server-side.
2. Refund reservation was inserted before PayPal dispatch.
3. Refund used a distinct stable request ID.
4. Refund targeted the original capture.
5. Currency remained USD.
6. Refund status completed or entered a supported pending/unknown state.
7. Refund journal entry balanced.
8. Refund webhook/state reconciled.
9. Remaining refundable balance is correct.
10. No duplicate refund exists.

Do not omit the refund amount.

---

# 13. Response-Loss Test

Run the judge-only injected response-loss scenario:

1. Dispatch a sandbox capture.
2. Deliberately discard the successful HTTP response before application parsing.
3. Persist `SENT_UNKNOWN` / `CAPTURE_UNCERTAIN`.
4. Keep the resource claim blocking.
5. Reconcile using the same request ID, provider GET, and/or verified webhook.
6. Reach one `COMPLETED` capture and one `CONFIRMED` booking.

Clearly label this:

```text
Injected response-loss test
```

Do not describe it as a real network outage.

---

# 14. Evidence to Record

Append a sanitized section to:

```text
docs/implementation-progress.md
```

Include:

- UTC timestamp.
- Git commit.
- Staging URL.
- Test command.
- PayPal environment: sandbox.
- Redacted order ID.
- Redacted capture ID.
- Capture status.
- Real webhook event type.
- Signature verification result.
- Partial refund status.
- Duplicate-effect count.
- Journal-balance assertion.
- Response-loss reconciliation result.

Never include:

- Client secret.
- Access token.
- Buyer password.
- Full customer identity.
- Raw unredacted webhook payload.

---

# 15. Completion Criteria

Epic 3 may become `VERIFIED` only when:

1. Real sandbox order creation passes.
2. Manual sandbox buyer approval passes.
3. Backend capture returns or reconciles to capture `COMPLETED`.
4. Real webhook delivery from the same app is verified.
5. Booking confirms exactly once.
6. Capture journal balances.
7. Partial refund succeeds or reaches a correctly supported provider-pending state.
8. Refund reconciliation and journal behavior pass.
9. No duplicate capture/refund/business effect exists.
10. Injected response-loss scenario reconciles.
11. All normal automated checks still pass.
12. Sanitized evidence is recorded.

If any item fails, retain:

```text
Epic 3 acceptance: CONDITIONAL
```

and document the blocker.

---

# 16. Cleanup

After testing:

1. Disable temporary tunnel if one was used.
2. Remove obsolete webhook registrations.
3. Keep only the intended staging webhook.
4. Do not delete useful sandbox transactions required for evidence.
5. Confirm local secrets remain untracked.
6. Rotate the sandbox client secret if it was accidentally exposed.
7. Run:

```zsh
git status --short
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Checkpoint the sanitized documentation separately from secrets.

---

# 17. Official References

- PayPal Developer Dashboard: https://developer.paypal.com/dashboard/
- JavaScript SDK v6 setup: https://developer.paypal.com/sdk/js/set-up
- PayPal Checkout integration: https://developer.paypal.com/checkout/integrate
- Orders v2: https://developer.paypal.com/api/orders/v2/
- Capture status: https://developer.paypal.com/api/orders/v2/definitions/capture
- PayPal webhooks: https://developer.paypal.com/api/rest/webhooks/rest
- Verify webhook signature: https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post
- Refund captured payment: https://developer.paypal.com/api/payments/v2/captures-refund
