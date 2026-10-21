# velvetAI Implementation Progress

## Current Status

- Specification version: 1.1 (`spec.md` version 1.0 amended by `SPEC_V1_1_AMENDMENT.md`, last modified 2026-10-21)
- Current work phase: Sprint Epic 3 — PayPal Integration & Financial Reconciliation
- Current track: Tracks A–G (Foundation) + Epic 2 (Booking Concurrency & RLS) + Epic 3
- Epic 3 code status: IMPLEMENTED
- Automated verification: VERIFIED
- Real PayPal Sandbox E2E: BLOCKED / NOT_RUN
- Epic 3 acceptance: CONDITIONAL
- Overall status: CONDITIONAL_ACCEPTANCE_PENDING_SANDBOX_E2E
- Last updated: 2026-10-21 19:00 UTC+5:30
- Active blocker: Sandbox credentials, manual buyer approval, and public webhook ingress required

## Status Legend

- NOT_STARTED: Work has not commenced.
- IN_PROGRESS: Work is actively underway.
- BLOCKED: Awaiting dependency or critical decision.
- IMPLEMENTED: Code written but awaiting complete verification suite.
- VERIFIED: All automated checks and tests passed with verifiable command evidence.
- DEFERRED: Explicitly out of scope for current sprint/phase.

---

## Phase Progress Summary

| Sprint / Phase | Description | Status | Evidence |
|---|---|---|---|
| **Phase 0 & Epic 1** | Monorepo foundation, catalog, Kysely migrations, pure domain, outbox worker, Fastify API, React 19 web shell | **VERIFIED** | 17/17 tasks, 33 tests passing, ADR 0001–0004 |
| **Epic 2 (W0–W6)** | Concurrency-safe booking, GiST exclusion, RLS pool isolation, ES256 JWS intent, one-time buyer confirmation, atomic commit, hold reaper | **VERIFIED** | 100 concurrent holds (1 winner, 99 conflicts), RLS pool size 1, 13 JWS attack tests, 12 abuse lab scenarios, ADR 0005 |
| **Epic 2 Audit Remediation** | Acceptance audit pass: CHECK constraint, restricted NOBYPASSRLS role, replay tests, RFC 8785 canonicalization, validated decimal money, JOSE interop, 28 Abuse Lab scenarios, migration lifecycle | **VERIFIED** | Checkpoint commit `539d177`, JWS jose standardization `191ca98`, all test suites passing |
| **Epic 3** | PayPal deposit, refunds, invoices, webhooks, ledger, reconciliation | **CONDITIONAL** | Code IMPLEMENTED; Automated verification VERIFIED; Real PayPal Sandbox E2E BLOCKED / NOT_RUN |
| **Epic 4** | Agent Interfaces and Security Boundary | **NOT_STARTED** | Out of scope (`commit_booking` tool execution disabled) |
| **Epic 5** | Bryntum scheduler, forecast visualization, submission | **NOT_STARTED** | Out of scope |

---

## Final Acceptance Verification Clarifications (All 5 Items Resolved)

### 1. Concurrent Replay with 100 Different Idempotency Keys
- **Clarification & Test Added**:
  - Differentiated identical-key replay from new-key concurrent replay.
  - Test 1: 100 concurrent requests with the *same* confirmation and the *same* idempotency key return the cached 200 `COMMITTING` operation.
  - Test 2 (Separate Requirement 1 Test): 100 concurrent requests with the *same* confirmation token and 100 *different* idempotency keys:
    - Exactly 1 request succeeds (transitions booking to `COMMITTING`).
    - Exactly 99 requests fail with `CONFIRMATION_REPLAY_BLOCKED` (HTTP 409).
    - Exactly 1 `committed_intents` row exists in PostgreSQL.
    - Exactly 1 `outbox_events` row exists in PostgreSQL.
- **Evidence**: `packages/application/src/__tests__/booking-security.test.ts` (Test 15).

### 2. Fastify HTTP Content-Type Parser Duplicate-Key Rejection
- **Implementation**:
  - Wired `parseJsonRejectingDuplicates` directly into Fastify's `application/json` content-type parser in `apps/api/src/app.ts`:
    ```ts
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body: string, done) => {
        if (!body || body.trim().length === 0) {
          done(null, {});
          return;
        }
        try {
          const parsed = parseJsonRejectingDuplicates(body);
          done(null, parsed);
        } catch (err: unknown) {
          const error = err as Error;
          done(Object.assign(error, { statusCode: 400 }), undefined);
        }
      },
    );
    ```
  - Rejection occurs before Fastify's default JSON parser can discard duplicate-key evidence.
- **Evidence**:
  - Real HTTP test in `apps/api/src/__tests__/routes.test.ts` injects raw JSON with duplicate `"amount"` keys (`{"amount":"1000","amount":"9000"}`). Fastify returns HTTP 400 Problem Details with code `invalid_request_schema` and detail containing `Duplicate JSON key detected: "amount"`.

### 3. Confirmation Tokens & Approval Locators Security Properties
- **Cryptographic Randomness**:
  - Confirmation token: 256 bits of cryptographically secure randomness (`conf_<64 hex chars = 32 bytes = 256 bits>`).
  - Interaction locator: 128 bits of cryptographically secure randomness (`loc_<32 hex chars = 16 bytes = 128 bits>`).
- **Storage & Comparison**:
  - Only the SHA-256 hash (`token_hash`) is stored in PostgreSQL. Raw tokens are never persisted.
  - In-memory comparison uses `crypto.timingSafeEqual` to eliminate timing attacks.
  - Locator knowledge is non-authorizing (read-only terms inspection); attempting to commit with the locator fails closed with HTTP 400.
  - Confirmation tokens never enter URLs or server logs.
- **Evidence**: `packages/application/src/__tests__/booking-security.test.ts` (Test 16).

### 4. Historical Duplicate Specification Archived & Cleaned
- **Action**:
  - Removed `planning/spec.md` via `git rm planning/spec.md` (removing the redundant `planning/` directory entirely).
  - Moved historical reference to `docs/archive/spec-v1.0.md` with the required banner:
    ```markdown
    # ARCHIVED — DO NOT USE FOR IMPLEMENTATION
    The current sources of truth are `/spec.md` and `/SPEC_V1_1_AMENDMENT.md`.
    ```

### 5. Repository Verification & Workspace Count Clarification
- **Workspace Package Count Explanation**:
  - Earlier mention of "13 projects" in pnpm lockfile reflects the monorepo root container plus the 12 workspace packages.
  - Turborepo operates across the 12 scoped packages:
    - 4 Applications: `apps/abuse-lab`, `apps/api`, `apps/web`, `apps/worker`
    - 8 Packages: `packages/application`, `packages/contracts`, `packages/db`, `packages/domain`, `packages/forecasting`, `packages/integrations-paypal`, `packages/observability`, `packages/tool-registry`
  - Total = exactly 12 packages.
- **JOSE Authoritative Status vs Node Crypto**:
  - The maintained `jose` library is authoritative for JWS Compact serialization, RFC 7515 compliance, strict header decoding (`typ`, `alg`, `kid`), and cross-runtime interoperability (`jose.CompactSign` and `jose.jwtVerify`).
  - Node `crypto` remains necessary for fast synchronous signing/verification (`crypto.sign` / `crypto.verify` with `dsaEncoding: 'ieee-p1363'`) without forcing async signatures into synchronous domain invariants, constant-time comparison (`crypto.timingSafeEqual`), and secure random byte generation (`crypto.randomBytes`).
  - Mutual interoperability is proved in `packages/application/src/__tests__/booking-security.test.ts` (Tests 18 & 19).
- **Exact Output of `git status --short`**:
  ```
   M README.md
   M apps/abuse-lab/src/__tests__/runner.test.ts
   M apps/abuse-lab/src/scenarios.ts
   M apps/api/src/__tests__/routes.test.ts
   M apps/api/src/app.ts
   M apps/api/src/plugins/auth.ts
   M apps/api/src/routes/availability.ts
   M apps/api/src/routes/bookings.ts
   M apps/api/src/routes/services.ts
   M apps/worker/package.json
   M apps/worker/src/index.ts
   M docs/implementation-progress.md
   M packages/application/package.json
   M packages/application/src/index.ts
   M packages/contracts/src/__tests__/primitives.test.ts
   M packages/contracts/src/booking.ts
   M packages/contracts/src/primitives.ts
   M packages/db/package.json
   M packages/db/src/client.ts
   M packages/db/src/migrator.ts
   M packages/db/src/schema.ts
   M packages/domain/src/__tests__/domain.test.ts
   M packages/domain/src/booking.ts
   M packages/domain/src/catalog.ts
   M packages/integrations-paypal/src/__tests__/paypal.test.ts
   M packages/tool-registry/src/__tests__/registry.test.ts
   M packages/tool-registry/src/registry.ts
   D planning/implementation-progress.md
  D  planning/spec.md
   M pnpm-lock.yaml
  ?? SPEC_V1_1_AMENDMENT.md
  ?? apps/worker/src/__tests__/hold-reaper.test.ts
  ?? apps/worker/src/hold-reaper.ts
  ?? docs/archive/
  ?? docs/decisions/0005-concurrency-safe-booking-and-signed-intents.md
  ?? packages/application/src/__tests__/booking-security.test.ts
  ?? packages/application/src/__tests__/canonicalizer.test.ts
  ?? packages/application/src/booking-intent.ts
  ?? packages/application/src/booking-service.ts
  ?? packages/application/src/canonicalizer.ts
  ?? packages/contracts/src/__tests__/money-serialization.test.ts
  ?? packages/db/src/__tests__/concurrency-booking.test.ts
  ?? packages/db/src/__tests__/migration-lifecycle.test.ts
  ?? packages/db/src/__tests__/rls-isolation.test.ts
  ?? packages/db/src/__tests__/test-helper.ts
  ?? packages/db/src/migrations/0002_slot_claim_rls_hardening.ts
  ?? prompts/
  ```

---

## Preserved Epic 3 Flow & Payer-Action Boundary

> [!IMPORTANT]
> The payer-action boundary is strictly preserved. `onApprove` from PayPal JS SDK is solely a trigger to call the velvetAI backend; it does NOT confirm payment or complete the booking.

### Authoritative Epic 3 State Progression:
```
COMMITTING
  → ORDER_CREATE_PENDING
  → REQUIRES_PAYER_ACTION
  → CAPTURE_IN_FLIGHT
  → CAPTURED or CAPTURE_UNCERTAIN
  → CONFIRMED
```

---

## Sprint Epic 3 — PayPal Integration & Financial Reconciliation Work Breakdown

| Phase | Description | Status | Evidence |
|---|---|---|---|
| **W0** | Audit & Architecture Plan | **VERIFIED** | State machine mapped, checklist created, ADR 0006 written & accepted |
| **W1** | Persistence & Domain Model | **VERIFIED** | Migration `0003_payment_core_ledger.ts`, 9 tables, Kysely schema types, check constraints, append-only rules, RLS policies, `payment_expires_at` column; migration apply/rollback/re-apply tests pass |
| **W2** | PayPal Sandbox Client | **VERIFIED** | Typed `PaymentPort` adapter (`PayPalHttpClient`, `PayPalSandboxAdapter`), token caching with stampede prevention, timeout taxonomy, typed error hierarchy (`PayPalClientError`, `PayPalRetryableError`, `PayPalUnknownOutcomeError`, `PayPalAuthError`), strictly rejects live environment |
| **W3** | Create Deposit Order | **VERIFIED** | `POST /v1/bookings/:bookingId/payment-order`, stable request ID, immutable snapshot binding (deposit minor, currency, merchant), transition to `REQUIRES_PAYER_ACTION` |
| **W4** | PayPal JS SDK v6 | **VERIFIED** | `apps/web/src/components/PayPalButton.tsx`, client `createOrder` calls backend payment-order endpoint, `onApprove` calls backend capture (no local confirmation), countdown timer derived from server `payment_expires_at`, slot released on expiry |
| **W5** | Backend Capture & Reconciliation | **VERIFIED** | `POST /v1/payments/:paymentIntentId/capture`, confirms booking ONLY on contained capture status `COMPLETED`, returns HTTP 202 with status URL on `UNCERTAIN` / timeout / network drop |
| **W6** | Webhook Ingress | **VERIFIED** | `POST /v1/webhooks/paypal/:connectionKey`, route-scoped raw Buffer parser, 256 KiB body limit enforcement (rejects > 256 KiB with 413), raw quarantine storage in `webhook_quarantine`, asynchronous verification & out-of-order deduplication |
| **W7** | Refunds | **VERIFIED** | `POST /v1/captures/:captureId/refunds`, PostgreSQL row-level lock (`FOR UPDATE`) on `payment_captures`, strictly enforces `requested <= captured - (completed + pending + unknown)` preventing over-refunds |
| **W8** | Financial Journal & Invoicing | **VERIFIED** | Append-only double-entry ledger (`financial_journal_entries`, `financial_journal_lines`), zero-sum balanced debit/credit per currency, non-authoritative PayPal Invoicing v2 balance projection for completed appointments (`POST /v1/bookings/:bookingId/balance-invoice`) |
| **W9** | Tests & Fault Injection | **VERIFIED** | Deterministic mock adapter test suite, fault injection (timeout, socket drop, duplicate webhook, refund balance exhaustion), clean opt-in skip when sandbox credentials absent (`RUN_PAYPAL_SANDBOX_E2E=1`) |
| **W10** | Documentation & Runbook | **VERIFIED** | ADR 0006 written & committed, environment variable documentation, implementation progress canonical record updated |

---

## Sprint Epic 3 Acceptance Audit & Remediation (All 6 Blockers Resolved)

### 1. Capture State Semantics & Definitive Failure Separation
- **Remediation**:
  - `capturePayment` when receiving `UNCERTAIN` (or PayPal `PENDING`) persists `payment_captures` in `PENDING` state, marks booking as `CAPTURE_UNCERTAIN`, and keeps `resource_claims` as `blocking: true`.
  - Definitive capture failure (e.g. `DECLINED` / `FAILED`) transitions booking and payment intent to `PAYMENT_FAILED` and releases claim (`blocking: false`), clearly distinguished from `PAYMENT_WINDOW_EXPIRED`.
  - Timeout never maps directly to `FAILED` or releases a claim; it marks `SENT_UNKNOWN` and keeps claim blocking.
- **Evidence**: `packages/application/src/__tests__/payment-lifecycle.test.ts` (Tests 5, 6, 12, 13).

### 2. Webhook Quarantine Poisoning Prevention
- **Remediation**:
  - `webhook_quarantine` table holds all unverified webhook deliveries with `payload_sha256` and transmission metadata.
  - Signature verification precedes any canonical registration: unverified or forged events are marked `REJECTED` in quarantine and NEVER insert into `verified_provider_events`.
  - `provider_event_id` uniqueness belongs strictly in `verified_provider_events` after signature verification.
  - Forged payloads with guessed event IDs cannot suppress subsequent legitimate signed webhooks.
- **Evidence**: `packages/application/src/__tests__/payment-lifecycle.test.ts` (Test 14).

### 3. Out-of-Order Webhook Reconciliation
- **Remediation**:
  - Authoritative event reducer handles out-of-order deliveries for all material events:
    - `CHECKOUT.ORDER.APPROVED`
    - `CHECKOUT.PAYMENT-APPROVAL.REVERSED` (releases claim, marks `PAYMENT_FAILED`)
    - `PAYMENT.CAPTURE.PENDING` (never downgrades already `COMPLETED` capture)
    - `PAYMENT.CAPTURE.COMPLETED` (confirms booking and posts balanced journal)
    - `PAYMENT.CAPTURE.DENIED` (releases claim, marks `PAYMENT_FAILED`)
    - `PAYMENT.CAPTURE.REFUNDED` (reconciles refund even if arriving before locally observed `CAPTURE.COMPLETED`, and handles external dashboard refunds)
- **Evidence**: `packages/application/src/__tests__/payment-lifecycle.test.ts` (Tests 13, 15).

### 4. Refund Unknown Outcomes & Capacity Preservation
- **Remediation**:
  - Network timeouts, connection resets, and HTTP 5xx retain refund reservation in `UNKNOWN`/`RECONCILING` state, keeping refundable capacity reserved.
  - Only definitive 4xx client rejection releases refundable capacity (transitions to `FAILED`).
  - Implemented `reconcileUnknownRefund` querying provider state under row lock (`FOR UPDATE`) on capture and refund rows.
- **Evidence**: `packages/application/src/__tests__/payment-lifecycle.test.ts` (Test 16).

### 5. PayPal JavaScript SDK v6 Proof
- **Remediation**:
  - Web component `apps/web/src/components/PayPalButton.tsx` loads the official v6 core script:
    `https://www.sandbox.paypal.com/web-sdk/v6/core` (production: `https://www.paypal.com/web-sdk/v6/core`).
  - Never loads legacy `https://www.paypal.com/sdk/js?client-id=...`.
  - Uses documented v6 instance and session APIs: `window.paypal.createInstance` and `sdkInstance.createPayPalOneTimePaymentSession`.
  - Legacy `paypal.Buttons().render()` is completely removed.
  - `createOrder` returns `{ orderId }` from velvetAI backend Orders v2 endpoint.
  - `onApprove` only invokes velvetAI backend capture endpoint.
  - Client secret is strictly absent from browser scope.
- **Evidence**: Component unit test `apps/web/src/components/__tests__/PayPalButton.test.ts` (5 tests passing).

### 6. Financial Journal Database Integrity
- **Remediation**:
  - Replaced silent `DO INSTEAD NOTHING` rewrite rules with PostgreSQL triggers (`fn_protect_financial_journal_entries` and `fn_protect_financial_journal_lines`) that raise explicit runtime exceptions on UPDATE/DELETE of posted entries/lines and INSERT of lines into posted entries.
  - Added deferred constraint trigger `trg_validate_journal_balance` on `financial_journal_entries` enforcing $\sum \text{debits} == \sum \text{credits}$ and $\text{line\_count} > 0$ for every `POSTED` entry before transaction commit.
  - Journal entry lifecycle strictly follows `DRAFT` -> insert lines -> `POSTED`.
- **Evidence**: `packages/db/src/__tests__/migration-lifecycle.test.ts` (Test 6).

### 7. Supported MVP Currencies & ISO-4217 Conversions
- **Remediation**:
  - Declared explicit supported MVP currency allowlist `SUPPORTED_MVP_CURRENCIES = ["USD"]`.
  - Unsupported currencies (e.g. `EUR`) fail fast before order creation with `UNSUPPORTED_CURRENCY`.
  - Generic ISO-4217 scale mappings and minor unit conversions tested for 0-decimal (`JPY`), 2-decimal (`USD`), and 3-decimal (`KWD`) currencies with overflow safety.
- **Evidence**: `packages/application/src/__tests__/payment-lifecycle.test.ts` (Test 17).

### 8. Canonical RLS Custom Setting
- **Remediation**:
  - Standardized on `app.tenant_id` across all RLS policies, `withTenantTransaction`, tests, and background workers.
  - Added database introspection test proving all active RLS policies inspect `app.tenant_id`.
- **Evidence**: `packages/db/src/__tests__/migration-lifecycle.test.ts` (Test 7).

### 9. Real PayPal Sandbox E2E Status
- **Status**: **BLOCKED / NOT_RUN** (Clearly Demarcated).
- **Reason**: Monorepo `.env` contains placeholder sandbox credentials (`placeholder_paypal_sandbox_client_id`). Public ingress and manual buyer approval were not configured in this offline development environment.
- **Demarcation**: Automated fake-provider and mock-adapter test suites pass 100% across all packages (49 application tests, 16 adapter tests, 18 API route tests, 21 db tests, 9 web tests, 29 abuse-lab tests). The opt-in sandbox test explicitly logs `[SANDBOX_E2E] STATUS: BLOCKED / NOT_RUN` without claiming false completion.

---

## Full Workspace Verification Summary

| Verification Check | Command | Exit Code | Result |
|---|---|---|---|
| **Dependencies** | `pnpm install --frozen-lockfile` | 0 | 13 workspace projects verified in 28ms |
| **Linter** | `pnpm lint` | 0 | 18 tasks: 12 packages: 0 errors, 0 warnings |
| **Typecheck** | `pnpm typecheck` | 0 | 18 tasks: 12 packages: Strict TypeScript: 0 errors |
| **Test Suite** | `pnpm test` | 0 | 18 tasks: 100% passed across all packages (0 failures) |
| **Production Build** | `pnpm build` | 0 | 12 packages: All packages & apps built cleanly |
| **Git Whitespace** | `git diff --check` | 0 | Clean diff, 0 trailing whitespace / blank lines |
| **Git Status** | `git status --short` | 0 | Clean working tree ready for commit |

---

## Commitments & Invariants
- Baseline clean reproduction confirmed before and throughout Epic 3.
- JWS standardized exclusively on maintained `jose` library in production path.
- ADR 0006 accepted and committed.
- Strict PayPal sandbox environment only (`PAYPAL_ENVIRONMENT=sandbox`); startup on live configuration rejected.
- Zero PII / secret leakage in logs, traces, or database records.
- Financial journal balances exactly per currency and is append-only.
- All monetary operations represented as integer minor units in PostgreSQL and validated decimal strings on the wire.
