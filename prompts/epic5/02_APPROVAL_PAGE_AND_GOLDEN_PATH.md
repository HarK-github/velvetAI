# Epic 5 · Work Package 02 — Buyer Approval Page and Golden Path

Priority: P0 · Time box: 2 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

A signed-in buyer can go from an AI suggestion to a confirmed, paid booking in one smooth flow:

```text
Ask AI (or MCP client) prepares a hold
  -> buyer opens /approve/:locator
  -> reviews terms in merchant time zone
  -> clicks "Approve and continue to payment"
  -> booking is committed by the HUMAN session (never by the AI)
  -> PayPal Sandbox deposit (existing PayPal JS SDK v6 button)
  -> page shows CONFIRMED only after backend capture COMPLETED
```

This is the most important screen in the demo. It proves "AI can prepare, only humans approve and pay".

## Preconditions

1. WP 01 VERIFIED.
2. `/approve/:locator` minimal page from EPIC4_FINAL_FIXES F1 exists. Find it: `rg -n "approve" apps/web/src`.
3. Find and list (with file paths) these existing pieces. Do not rebuild them:
   - Approval read route: `GET /v1/booking-approvals/:locator`
   - Approval confirm route: `POST /v1/booking-approvals/:locator/confirm`
   - Commit logic in `BookingService` and the REST commit route
   - Booking status read route (for example `GET /v1/bookings/:id`) or `get_booking.v1`
   - `apps/web/src/components/PayPalButton.tsx` and how `/book` uses it
   - Payment order route `POST /v1/bookings/:bookingId/payment-order` and capture route `POST /v1/payments/:paymentIntentId/capture`
   - The slot `display` fields added by the time zone fix

## Design decisions (follow exactly)

### D1. Who commits after human approval

Add one human-only route that performs approve + commit atomically from the buyer's point of view:

```text
POST /v1/booking-approvals/:locator/approve-and-commit
Headers: Authorization: Bearer <Auth0 USER access token>, Idempotency-Key: <uuid>
Body: {}   (empty object; terms are resolved server-side from the locator)
```

Server steps:

1. Authenticate. Reject M2M tokens (`sub` ending in `@clients` or token from client-credentials grant), missing tokens, and dev tokens outside tests → 401/403 `HUMAN_APPROVAL_REQUIRED`.
2. Load the pending approval by locator inside `withTenantTransaction` for the hold's tenant.
3. Check the authenticated buyer is the buyer bound to the hold (from F1). Otherwise 403 `APPROVAL_BELONGS_TO_ANOTHER_BUYER`.
4. Check the hold has not expired → otherwise 410 `HOLD_EXPIRED`.
5. Create the one-time confirmation (reuse existing confirm logic; do not duplicate code — extract a shared function if needed).
6. Commit using the stored signed intent for that hold and the confirmation, exactly like the existing commit path (same function). If the signed intent is not persisted at prepare time, persist the compact JWS and its SHA-256 hash at prepare time in the existing pending approval/hold row (JWS is integrity data, not a secret). Add a migration if a column is needed.
7. Return:

```json
{
  "bookingId": "…",
  "status": "COMMITTING",
  "next": { "type": "PAY_DEPOSIT", "paymentOrderUrl": "/v1/bookings/<id>/payment-order" }
}
```

Never return the confirmation token.

Keep the existing separate `/confirm` route working (MCP agents use confirm-by-human then agent commit). Both paths must be safe together:

- If the human already used approve-and-commit, a later agent `commit_booking.v1` returns a non-error result with code `ALREADY_COMMITTED`, the booking id, and current status. It does not create a second booking or consume anything.
- If the agent committed first (after a human `/confirm`), approve-and-commit returns 200 with the existing booking (idempotent outcome), not an error.

Add the route to the idempotency plugin list.

### D2. Page states (each needs its own UI and test)

| State               | When                                       | What the buyer sees                                                                                                                       | Primary action                                                             |
| ------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `loading`           | fetching locator                           | skeleton                                                                                                                                  | —                                                                          |
| `sign_in_required`  | no Auth0 session                           | terms summary + "Sign in to approve"                                                                                                      | Sign in (Auth0 `loginWithRedirect` with `appState.returnTo` = current URL) |
| `ready`             | valid, unexpired, belongs to buyer         | full terms + countdown                                                                                                                    | Approve and continue to payment                                            |
| `wrong_buyer`       | 403 APPROVAL_BELONGS_TO_ANOTHER_BUYER      | "This approval belongs to another account."                                                                                               | Sign out / switch account                                                  |
| `expired`           | hold expired                               | "This hold expired. The time was released."                                                                                               | Find a new time (link to /book with service preselected)                   |
| `committing`        | after click                                | progress                                                                                                                                  | —                                                                          |
| `pay_deposit`       | status awaiting payer                      | PayPal button + deposit amount + payment window countdown from server `payment_expires_at`                                                | PayPal                                                                     |
| `verifying_payment` | `CAPTURE_IN_FLIGHT` or `CAPTURE_UNCERTAIN` | "We're verifying your payment with PayPal. This can take a minute." Poll every 3 s up to 2 min, then every 10 s                           | —                                                                          |
| `confirmed`         | `CONFIRMED`                                | success card: service, time (merchant zone + "Your time"), deposit paid, PayPal capture id truncated, add-to-calendar (.ics download, P2) | View booking / Back to home                                                |
| `payment_failed`    | `PAYMENT_FAILED`                           | "Payment didn't go through. Your time was released."                                                                                      | Find a new time                                                            |
| `already_done`      | already committed/confirmed                | jump to the matching state above                                                                                                          | —                                                                          |
| `error`             | other errors                               | safe message + Retry                                                                                                                      | Retry                                                                      |

### D3. Terms shown in `ready`

- Service name, duration.
- Provider/resource display name.
- Date and start–end time in merchant time zone with label, plus "Your time: …" when the browser zone differs. Use server `display` fields only.
- Price (formatted), deposit (formatted), balance due at appointment.
- Cancellation policy tiers in plain words, for example "Free cancellation until Mon 26 Oct, 2:00 PM EDT. After that the $20.00 deposit is kept."
- Why this deposit (placeholder line now; WP 06 fills it from the forecast): show nothing if absent.
- "Prepared by Ask AI" / "Prepared by MCP client" / "Prepared by you" based on the hold's recorded surface.
- Hold expiry countdown computed from server `expiresAt` and server time offset (fetch server `Date` header once and compute offset; do not trust the client clock alone).
- A checkbox "I agree to these terms" that must be checked before the Approve button is enabled.

### D4. Security on this page

- Route `/approve/:locator` must send `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Locally: Vite dev/preview `server.headers`/`preview.headers`. In production: nginx config and Render static site headers (WP 03 adds Render headers; add nginx now).
- The locator is in the URL (allowed: it's non-authorizing). The confirmation token is never in the URL or browser storage.
- Do not log the locator at info level in the browser console.

### D5. Ask AI and MCP integration

- Ask AI approval card "Open approval page" links to `<web origin>/approve/<locator>` (opens in same tab; the drawer state may be lost, that's fine).
- `prepare_booking.v1` output includes `approvalUrl` as an absolute web URL built from a server config `PUBLIC_WEB_ORIGIN` (local `http://localhost:5173`). Keep the old API locator path field for backward compatibility if tests depend on it.
- Update `scripts/mcp-external-smoke.ts` to print the web approval URL. The human approves with the page's separate "Approve only" secondary action (calls `/confirm`), then the agent commits. Keep both flows tested.

Add a secondary small text button "Approve only (let my assistant finish)" visible only when the hold was prepared by an MCP client. Primary button remains approve-and-commit.

## Files (expected; adapt to repo conventions and report)

```text
apps/api/src/routes/booking-approvals.ts        (add approve-and-commit)
packages/application/src/booking-service.ts      (shared confirm+commit function, ALREADY_COMMITTED)
packages/contracts/src/booking-approval.ts       (request/response schemas)
packages/tool-registry/src/registry.ts           (approvalUrl, ALREADY_COMMITTED)
packages/db/src/migrations/00NN_*.ts              (only if intent JWS must be persisted)
apps/web/src/pages/ApprovePage.tsx
apps/web/src/components/approval/*.tsx           (TermsCard, Countdown, StatusPanel)
apps/web/src/lib/approval-api.ts
docker/nginx-web.conf                            (headers for /approve)
apps/web/vite.config.ts                          (dev/preview headers)
scripts/mcp-external-smoke.ts
```

## Tests (all required)

API (`apps/api/src/__tests__/approval-commit.test.ts`):

1. Human buyer approve-and-commit → 200, status COMMITTING, exactly 1 committed intent, exactly 1 outbox event.
2. Same Idempotency-Key replay → same response, still exactly 1 committed intent.
3. M2M token → 403 HUMAN_APPROVAL_REQUIRED, zero state change.
4. No token → 401, zero state change.
5. Buyer B → 403 APPROVAL_BELONGS_TO_ANOTHER_BUYER, zero state change.
6. Expired hold → 410 HOLD_EXPIRED, claim not blocking.
7. Agent commit after human approve-and-commit → ALREADY_COMMITTED, still 1 booking.
8. Human approve-and-commit after agent commit → 200 returns existing booking.
9. Response body never contains a string starting with `conf_` (assert on JSON string).
10. Missing Idempotency-Key → 400.

Web (`apps/web/src/__tests__/approve-page.test.tsx`), mocking the API client:

- One test per state in D2 (12 tests). Assert visible text and the primary action.
- Approve button disabled until the terms checkbox is checked.
- Time shown equals server `display.localStart` and the zone label; "Your time" shown when `process.env.TZ`/mocked browser zone differs.
- Never renders `$0.00` when money is missing.

End-to-end (Playwright, local stack, FakeModelProvider, PayPal mock adapter — reuse the existing Playwright setup if present; otherwise add `apps/web/e2e/golden-path.spec.ts` and a `pnpm e2e` script):

```text
sign in as test buyer (use the existing Playwright auth approach; never hardcode real passwords; read from env)
open Ask AI -> "Book a haircut tomorrow at 2 PM"
click "Open approval page"
check terms -> click Approve and continue to payment
mock PayPal approve -> backend capture COMPLETED
assert CONFIRMED card
assert GET /v1/merchant/schedule (or booking read route) includes the booking
```

If Playwright cannot log in through Auth0 in CI, run the E2E with mock auth enabled only in the e2e environment (`NODE_ENV=test`), and do the real Auth0 path manually (below).

## Manual verification (real services)

With real Auth0, real Gemini, real PayPal Sandbox locally:

1. Sign in as the test buyer.
2. Ask AI: "Book an Executive Haircut tomorrow afternoon". Click a time chip.
3. Open approval page. Verify time and zone label, deposit, policy text, countdown.
4. Approve. Pay with the PayPal Sandbox buyer account.
5. Verify CONFIRMED card.
6. Open the same approval link in a private window signed in as a different user → "belongs to another account".
7. Wait for a new hold to expire on the approval page → expired state.
8. Run `pnpm mcp:smoke` and approve with "Approve only" → agent commit succeeds; then try approve-and-commit on the same locator → shows the existing booking.

Save screenshots (no tokens, no emails visible — blur or use the test account display name) to `docs/evidence/golden-path/` and write `docs/evidence/golden-path-local.md`.

## Definition of done

- [ ] Route, shared service function, and tests pass.
- [ ] All 12 page states implemented and tested.
- [ ] Playwright golden path passes.
- [ ] Manual steps 1–8 performed and evidenced.
- [ ] Checklist items 1, 3, 4 updated.
- [ ] Full verification set passes, committed, report delivered.

## Cut list (if late)

You may cut only: (1) the .ics calendar download, (2) visual polish of the "Approve only" secondary button (keep its function). Never cut any page state, the server time offset, the terms checkbox, or any security test.

## Out of scope

Bryntum, forecasting, Render, judge features.
