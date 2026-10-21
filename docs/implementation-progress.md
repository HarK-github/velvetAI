# velvetAI Implementation Progress

## Current Status

- Specification version: 1.1 (`spec.md` version 1.0 amended by `SPEC_V1_1_AMENDMENT.md`, last modified 2026-10-21)
- Current work phase: Sprint Epic 2 Final Acceptance Verification (COMPLETED & VERIFIED)
- Current track: Tracks A–G (Foundation) + Epic 2 W0–W6 (Booking Concurrency, Cryptography & RLS) + Acceptance Verification
- Overall status: VERIFIED (All 5 Acceptance Clarifications Resolved)
- Last updated: 2026-10-21 13:45 UTC+5:30
- Active blocker: None (Ready for Sprint Epic 3)

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
| **Epic 2 Audit Remediation** | Acceptance audit pass: CHECK constraint, restricted NOBYPASSRLS role, replay tests, RFC 8785 canonicalization, validated decimal money, JOSE interop, 28 Abuse Lab scenarios, migration lifecycle | **VERIFIED** | 31/31 application tests, 18/18 db tests, 16/16 contracts tests, 29/29 abuse lab tests, 11/11 api tests, 0 lint/typecheck errors |
| **Epic 3** | PayPal deposit, refunds, invoices, webhooks, ledger, reconciliation | **NOT_STARTED** | State progression corrected per audit; strictly deferred to Epic 3 |
| **Epic 4** | MCP, WebMCP progressive enhancement, Ask AI, and security boundary | **NOT_STARTED** | Out of scope (`commit_booking` tool execution disabled) |
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

## Full Workspace Verification Summary

| Verification Check | Command | Exit Code | Result |
|---|---|---|---|
| **Linter** | `pnpm lint` | 0 | 12 packages: 0 errors, 0 warnings |
| **Typecheck** | `pnpm typecheck` | 0 | 12 packages: Strict TypeScript: 0 errors |
| **Test Suite** | `pnpm test` | 0 | 17 tasks: 100% passed across all packages |
| **Production Build** | `pnpm build` | 0 | 12 packages: All packages & apps built cleanly |
| **Git Whitespace** | `git diff --check` | 0 | Clean diff, 0 trailing whitespace / blank lines |
| **Git Status** | `git status --short` | 0 | Canonical records synchronized, duplicates removed |

---

## Commitments
- Acceptance verification complete.
- Zero PayPal side effects added.
- Sprint Epic 3 implementation has not commenced.
