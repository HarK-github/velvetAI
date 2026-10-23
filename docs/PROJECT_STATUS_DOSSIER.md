# velvetAI Repository Status Dossier

## 1. Audit Metadata

- **Audit Timestamp (UTC)**: 2026-10-21T17:25:00Z
- **Local Time**: 2026-10-21T22:55:00+05:30
- **Branch**: `feat/epic-3-paypal-sandbox`
- **Full Commit SHA**: `6d3c9f00d8d21a9bfca144cd42c52486ad7e961b`
- **Short Commit SHA**: `6d3c9f0`
- **Working-Tree Status**: ` M prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md` (uncommitted trailing blank line added at line 824 by user prompt submission; all application source code, configuration, packages, and tests are clean and fully committed).
- **Node.js Version**: `v22.23.3`
- **pnpm Version**: `12.14.0`
- **PostgreSQL Version**: `PostgreSQL 17.11 (Homebrew) on aarch64-apple-darwin27.0.0, compiled by Apple clang version 21.0.0 (clang-2100.3.34.2), 64-bit`
- **Specification Sources and Precedence**:
  1. `SPEC_V1_1_AMENDMENT.md` (dated 2026-10-21, canonical amendment; strictly supersedes any conflicting requirement in `spec.md`).
  2. `spec.md` (v1.0 baseline specification).
  3. `docs/decisions/` (ADRs 0001 through 0006, binding architectural decisions).
  4. `docs/archive/spec-v1.0.md` (archived snapshot, marked non-authoritative).
- **Auditor Limitation**: Read-only repository and local verification inspection only; no live external PayPal mutations or webhook listener processes initiated during this audit.

---

## 2. Executive Status

| #   | Question                                    | Status                     | Confidence | Implementation Evidence                                                                                    | Verification Evidence                                                                                                       | Remaining Gap                                                                              |
| --- | ------------------------------------------- | -------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Is the backend foundation ready?            | **AUTOMATED_VERIFIED**     | HIGH       | `apps/api`, `packages/application`, `packages/domain`, `packages/db`, `packages/contracts`                 | `pnpm lint`, `pnpm typecheck`, `pnpm test` (190 passing tests)                                                              | None for core monolith.                                                                    |
| 2   | Is concurrency-safe booking ready?          | **AUTOMATED_VERIFIED**     | HIGH       | GiST exclusion constraint on `resource_claims`, `chk_resource_claim_blocking_state`, `HoldReaperProcessor` | `packages/db/src/__tests__/concurrency-booking.test.ts` (100 concurrent holds, 1 winner / 99 409s)                          | None for fixed-duration MVP.                                                               |
| 3   | Is automated PayPal integration ready?      | **AUTOMATED_VERIFIED**     | HIGH       | `PayPalHttpClient`, `PayPalSandboxAdapter`, `PaymentService`, webhook quarantine, ledger triggers          | `packages/integrations-paypal/src/__tests__/paypal.test.ts`, `packages/application/src/__tests__/payment-lifecycle.test.ts` | Daily report/settlement reconciliation worker is deferred.                                 |
| 4   | Has real PayPal Sandbox E2E been evidenced? | **REAL_E2E_VERIFIED**      | HIGH       | `docs/implementation-progress.md`, `docs/runbooks/paypal-sandbox-e2e.md`, `PayPalButton.tsx`               | Sanitized sandbox run: Order `26B9…125W`, capture `91P4…790B`, webhook `WH-7Y72…7105M`, refund `7M63…105F`                  | Hosted public ingress for webhooks currently closed.                                       |
| 5   | Is the customer website locally functional? | **AUTOMATED_VERIFIED**     | MEDIUM     | `apps/web/src/pages/`, `apps/web/src/components/`, `PayPalButton.tsx`                                      | `apps/web/src/__tests__/app.test.ts`, component tests                                                                       | Services list is mock data; scheduler is custom React state countdown rather than Bryntum. |
| 6   | Is the website stably hosted?               | **ABSENT**                 | HIGH       | None                                                                                                       | `find . -name "*render*"` returns zero files                                                                                | Render static web service configuration does not exist.                                    |
| 7   | Are MCP tools functional?                   | **SCAFFOLDED**             | HIGH       | `packages/tool-registry/src/registry.ts` registers 6 tools                                                 | `packages/tool-registry/src/__tests__/registry.test.ts`                                                                     | `commit_booking` explicitly `enabled: false`; no Streamable HTTP transport server.         |
| 8   | Is WebMCP functional?                       | **ABSENT**                 | HIGH       | None in `apps/web`                                                                                         | Grep for `document.modelContext` returns zero hits                                                                          | WebMCP browser declaration adapter not built.                                              |
| 9   | Is in-page Ask AI functional?               | **ABSENT**                 | HIGH       | None in `apps/web`                                                                                         | No conversational UI component in `apps/web`                                                                                | In-page LLM assistant interface not implemented.                                           |
| 10  | Is Bryntum functional?                      | **ABSENT**                 | HIGH       | None in `apps/web`                                                                                         | `@bryntum/scheduler` absent from `apps/web/package.json`                                                                    | Bryntum Scheduler component not implemented.                                               |
| 11  | Are forecasts visible in the product?       | **SCAFFOLDED**             | HIGH       | `@velvetai/forecasting` statistical algorithms                                                             | `packages/forecasting/src/__tests__/forecasting.test.ts`                                                                    | No DB persistence, no training pipeline, not imported in `apps/web`.                       |
| 12  | Is Judge Mode functional?                   | **DOCUMENTED_ONLY**        | HIGH       | Specified in `SPEC_V1_1_AMENDMENT.md` Section J                                                            | No route `POST /v1/judge/reset` in `apps/api`                                                                               | Judge reset endpoint, isolated tenant seed, and technical proof panel absent.              |
| 13  | Is the project hackathon-demo ready?        | **IMPLEMENTED_UNVERIFIED** | HIGH       | Backend, booking concurrency, PayPal sandbox, and security lab fully functional                            | Local demo works for booking + PayPal + ledger; incomplete for AI and Bryntum                                               | Agent interfaces, scheduler, and judge mode missing.                                       |
| 14  | Is the project Devpost-submission ready?    | **SCAFFOLDED**             | HIGH       | Architectural docs, ADRs, runbooks present                                                                 | Missing public license, video, live URL, submission copy                                                                    | License file missing; public video (< 3 min) not recorded.                                 |
| 15  | Is the project production ready?            | **IMPLEMENTED_UNVERIFIED** | HIGH       | PostgreSQL 17 RLS, zero-sum double-entry ledger, append-only triggers                                      | Passes release gates L.1–L.6; missing L.7–L.8                                                                               | Production OIDC provider, daily reconciliation, staging deployment.                        |

### Overall Engineering Statement

```text
Engineering epics completed: 3 of 5
Hackathon submission readiness: SCAFFOLDED
Primary current blocker: Agent Interfaces (Epic 4: MCP / WebMCP / Ask AI) and Visual Scheduler (Epic 5: Bryntum / Forecast UI / Judge Mode) are not yet implemented.
Recommended next epic: Epic 4 (Agent Interfaces and Security Boundary).
```

---

## 3. Repository and Workspace Inventory

### Workspace Packages Inventory

The monorepo contains exactly **12 workspace packages** (managed by pnpm and Turborepo) inside one root repository container (`velvetai-monorepo@0.1.0`):

#### Applications (`apps/`)

1. **`@velvetai/abuse-lab`** (`apps/abuse-lab`): Automated attack suite executing 28 deterministic security scenarios + runner test covering Amendment Section I.
2. **`@velvetai/api`** (`apps/api`): Fastify 5 REST API application providing 19 route definitions, RFC 9457 Problem Details, and duplicate-key rejection.
3. **`@velvetai/web`** (`apps/web`): React 19 / Vite single-page application integrating PayPal JS SDK v6, booking flow, and policy inspect.
4. **`@velvetai/worker`** (`apps/worker`): Background worker providing transactional outbox processing and `HoldReaperProcessor` with `SKIP LOCKED`.

#### Shared Packages (`packages/`)

5. **`@velvetai/application`** (`packages/application`): Hexagonal application layer containing `BookingService`, `PaymentService`, JWS token signers, ports, and canonicalizer.
6. **`@velvetai/contracts`** (`packages/contracts`): Shared Zod schemas, branded primitives (`UUID`, `MoneyMinor`, `IanaTimeZone`), RFC 9457 error contracts.
7. **`@velvetai/db`** (`packages/db`): PostgreSQL 17 migrations, Kysely query builder client, and `withTenantTransaction` RLS context wrapper.
8. **`@velvetai/domain`** (`packages/domain`): Pure domain models, entities, aggregate invariants, and custom `DomainError` classes (zero framework dependencies).
9. **`@velvetai/forecasting`** (`packages/forecasting`): Pure mathematical algorithms for no-show probability, slot-fill estimation, Brier score, and WAPE.
10. **`@velvetai/integrations-paypal`** (`packages/integrations-paypal`): Typed PayPal REST adapters (`Orders v2`, `Payments v2`, `Invoicing v2`, `Webhooks v1`).
11. **`@velvetai/observability`** (`packages/observability`): Pino structured logging with mandatory secret/PII redaction and Zod environment variable parsing.
12. **`@velvetai/tool-registry`** (`packages/tool-registry`): Schema definitions and registration metadata for shared AI/REST booking tools.

### Documentation Directories

- `docs/`: Progress reports (`implementation-progress.md`).
- `docs/decisions/`: Architecture Decision Records (`0001-modular-monolith.md`, `0002-postgresql-as-authority.md`, `0003-transactional-outbox.md`, `0004-oidc-authentication-boundary.md`, `0005-concurrency-safe-booking-and-signed-intents.md`, `0006-paypal-payment-finality-and-reconciliation.md`).
- `docs/runbooks/`: Operational procedures (`paypal-sandbox-e2e.md`).
- `docs/archive/`: Historical non-authoritative documents (`spec-v1.0.md`).

### Prompt Files

- `prompts/EPIC2_BOOKING_PROMPT.md`
- `prompts/EPIC3_PAYPAL_INTEGRATION_PROMPT.md`
- `prompts/EPIC3_ACCEPTANCE_AUDIT.md`
- `prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md`

### Database Migrations

- `packages/db/src/migrations/0001_initial_schema.ts`
- `packages/db/src/migrations/0002_slot_claim_rls_hardening.ts`
- `packages/db/src/migrations/0003_payment_core_ledger.ts`

### Deployment and Infrastructure Files

- `docker-compose.yml` (orchestrating `postgres:17-alpine` and `redis:7-alpine`)
- `docker/init-db.sql` (enabling `uuid-ossp` and `btree_gist` extensions)
- Note: No `Dockerfile` for application services and no `render.yaml` exist in the repository.

### Inventory Analysis & Findings

- **Workspace Count Explanation**: The pnpm workspace defines 12 scoped packages under `apps/*` and `packages/*`. The root directory is declared as a private monorepo container.
- **Redundant Planning Directory**: The historical `planning/` directory was previously deleted via `git rm` during Epic 2 closeout; no duplicate `spec.md` exists outside `docs/archive/`.
- **Dead/Unconnected Package**: `@velvetai/forecasting` is built, tested, and linted, but has zero inbound calls from `@velvetai/api` or `@velvetai/web`.
- **Empty Scaffolding**: `packages/tool-registry` contains mock handlers for tools; tool `commit_booking` is explicitly disabled with `enabled: false`.

---

## 4. Architecture Actually Implemented

### Bounded Contexts

```mermaid
graph TD
    Client[Browser / REST Client] --> Fastify[apps/api Fastify 5]

    subgraph Security Boundary
        Parser[Duplicate Key Parser]
        Auth[OIDC / Mock JWT Auth]
        Idemp[Idempotency Plugin]
    end

    Fastify --> Parser --> Auth --> Idemp

    subgraph Application Layer
        CatalogSvc[CatalogService]
        AvailSvc[AvailabilityService]
        BookingSvc[BookingService]
        PaymentSvc[PaymentService]
        JWS[JWS Intent & Token Signer]
        ToolReg[packages/tool-registry]
    end

    Idemp --> CatalogSvc
    Idemp --> AvailSvc
    Idemp --> BookingSvc
    Idemp --> PaymentSvc
    BookingSvc --> JWS

    subgraph Data & Persistence [PostgreSQL 17 with 25 RLS Tables]
        Trx[withTenantTransaction app.tenant_id]
        Catalog[(services & service_versions)]
        Rules[(resources & availability_rules)]
        Claims[resource_claims - GiST Exclusion]
        Snapshots[booking_hold_snapshots]
        Intents[committed_intents & buyer_confirmations]
        PayIntents[payment_intents & payment_captures]
        ProvOps[provider_operations Journal]
        Quarantine[webhook_quarantine Inbox]
        VerifiedEvt[verified_provider_events]
        Ledger[financial_journal_entries & lines - Zero-Sum Triggers]
        Outbox[outbox_events - Fenced Lease]
    end

    CatalogSvc --> Trx --> Catalog
    AvailSvc --> Trx --> Rules
    AvailSvc --> Trx --> Claims
    BookingSvc --> Trx --> Claims
    BookingSvc --> Trx --> Snapshots
    BookingSvc --> Trx --> Intents
    BookingSvc --> Trx --> Outbox
    PaymentSvc --> Trx --> PayIntents
    PaymentSvc --> Trx --> ProvOps
    PaymentSvc --> Trx --> Quarantine
    PaymentSvc --> Trx --> VerifiedEvt
    PaymentSvc --> Trx --> Ledger
    PaymentSvc --> Trx --> Outbox

    subgraph External Providers
        PayPal[PayPal Sandbox API v2]
    end

    PaymentSvc --> PayPalAdapter[PayPalSandboxAdapter]
    PayPalAdapter --> PayPal

    subgraph Background Workers [apps/worker]
        Reaper[HoldReaperProcessor - SKIP LOCKED]
        OutboxProc[PostgreSqlOutboxStore - Fenced Lease]
        ReconcileProc[ReconciliationProcessor - idx_provider_operations_reconcile]
    end

    Reaper --> Trx
    OutboxProc --> Trx
    ReconcileProc --> Trx
    ReconcileProc --> PayPalAdapter
```

#### 1. Identity and Tenancy

- **Owning Package**: `packages/domain`, `packages/db`, `apps/api/src/plugins/auth.ts`.
- **Public Symbols**: `Tenant`, `UserPrincipal`, `Membership`, `withTenantTransaction`.
- **Database Tables**: `tenants`, `app_users`, `memberships`.
- **Inbound Adapters**: Fastify `authPlugin` inspecting `Authorization: Bearer <jwt>` and populating `request.principal`.
- **Outbound Adapters**: PostgreSQL `SELECT set_config('app.tenant_id', $1, true)`.
- **Tests**: `packages/db/src/__tests__/rls-isolation.test.ts`, `packages/domain/src/__tests__/domain.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH).

#### 2. Catalog and Policy

- **Owning Package**: `packages/domain`, `apps/api/src/routes/services.ts`.
- **Public Symbols**: `Service`, `ServiceVersion`, `Resource`, `CancellationPolicy`.
- **Database Tables**: `services`, `service_versions`, `resources`, `locations`.
- **Inbound Adapters**: `GET /v1/services`.
- **Outbound Adapters**: In-memory static catalog `MOCK_SERVICES` (not querying DB in current handler).
- **Tests**: `packages/domain/src/__tests__/domain.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH for domain; `SCAFFOLDED` for API DB persistence).

#### 3. Availability

- **Owning Package**: `packages/domain`, `apps/api/src/routes/availability.ts`.
- **Public Symbols**: `TimeRange`, `AvailabilityRule`, `predictSlotFillProbability`.
- **Database Tables**: `availability_rules`, `resources`.
- **Inbound Adapters**: `GET /v1/availability`.
- **Outbound Adapters**: Deterministic 9:00–17:00 slot generator with simulated fill scores.
- **Tests**: `apps/api/src/__tests__/routes.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH).

#### 4. Booking

- **Owning Package**: `packages/application/src/booking-service.ts`, `apps/api/src/routes/bookings.ts`.
- **Public Symbols**: `BookingService`, `prepareBooking`, `getApprovalDetails`, `confirmApproval`, `commitBooking`, `prepareCancellation`.
- **Database Tables**: `booking_quotes`, `bookings`, `resource_claims`, `booking_hold_snapshots`, `buyer_confirmations`, `committed_intents`.
- **Inbound Adapters**: `POST /v1/booking-quotes`, `POST /v1/bookings/prepare`, `GET /v1/booking-approvals/:locator`, `POST /v1/booking-approvals/:locator/confirm`, `POST /v1/bookings/commit`, `GET /v1/bookings/:id`.
- **Outbound Adapters**: PostgreSQL transactions using Kysely.
- **Tests**: `packages/db/src/__tests__/concurrency-booking.test.ts`, `packages/application/src/__tests__/booking-security.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH).

#### 5. Payments and Billing

- **Owning Package**: `packages/application/src/payment-service.ts`, `packages/integrations-paypal`, `apps/api/src/routes/payments.ts`.
- **Public Symbols**: `PaymentService`, `createDepositOrder`, `capturePayment`, `refundPayment`, `createBalanceInvoice`, `PayPalSandboxAdapter`.
- **Database Tables**: `provider_connections`, `provider_operations`, `payment_intents`, `payment_captures`, `refund_reservations`, `invoices`, `webhook_quarantine`, `verified_provider_events`.
- **Inbound Adapters**: `POST /v1/bookings/:bookingId/payment-order`, `POST /v1/payments/:paymentIntentId/capture`, `POST /v1/captures/:captureId/refunds`, `POST /v1/bookings/:bookingId/balance-invoice`, `POST /v1/webhooks/paypal/:connectionKey`.
- **Outbound Adapters**: PayPal REST API v2 (`api-m.sandbox.paypal.com`).
- **Tests**: `packages/integrations-paypal/src/__tests__/paypal.test.ts`, `packages/application/src/__tests__/payment-lifecycle.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` and `REAL_E2E_VERIFIED` (Confidence: HIGH).

#### 6. Financial Journal

- **Owning Package**: `packages/application/src/payment-service.ts`, `packages/db`.
- **Public Symbols**: `recordJournalEntry`, `postJournalEntry`.
- **Database Tables**: `financial_journal_entries`, `financial_journal_lines`.
- **Inbound Adapters**: Invoked internally by `capturePayment`, `refundPayment`, and webhook reducers.
- **Outbound Adapters**: PostgreSQL triggers `fn_protect_financial_journal_entries`, `fn_protect_financial_journal_lines`, `fn_validate_journal_entry_balance`.
- **Tests**: `packages/db/src/__tests__/migration-lifecycle.test.ts` (Test 6).
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH).

#### 7. Forecasting

- **Owning Package**: `packages/forecasting`.
- **Public Symbols**: `predictNoShowProbability`, `predictSlotFillProbability`, `calculateBrierScore`, `calculateWAPE`.
- **Database Tables**: None.
- **Inbound Adapters**: None.
- **Outbound Adapters**: None.
- **Tests**: `packages/forecasting/src/__tests__/forecasting.test.ts` (4 passing tests).
- **Status**: `AUTOMATED_VERIFIED` for algorithms; `ABSENT` for database persistence and UI integration (Confidence: HIGH).

#### 8. Agent Gateway / Tool Registry

- **Owning Package**: `packages/tool-registry`.
- **Public Symbols**: `ToolRegistry`, `sharedToolRegistry`, 6 tool declarations.
- **Database Tables**: None.
- **Inbound Adapters**: None (no HTTP Streamable transport mounted).
- **Outbound Adapters**: Mock execution handlers.
- **Tests**: `packages/tool-registry/src/__tests__/registry.test.ts`.
- **Status**: `SCAFFOLDED` (Confidence: HIGH).

#### 9. Audit and Abuse Lab

- **Owning Package**: `apps/abuse-lab`, `packages/application/src/canonicalizer.ts`.
- **Public Symbols**: `AbuseLabRunner`, 28 attack scenarios (`SEC-001` through `SEC-028`).
- **Database Tables**: `audit_events`.
- **Inbound Adapters**: Vitest runner in `apps/abuse-lab/src/__tests__/runner.test.ts`.
- **Outbound Adapters**: Kysely database clients and HTTP API mocks.
- **Tests**: 29 passed tests in `apps/abuse-lab`.
- **Status**: `AUTOMATED_VERIFIED` (Confidence: HIGH).

#### 10. Notifications and Workers

- **Owning Package**: `apps/worker`.
- **Public Symbols**: `HoldReaperProcessor`, `OutboxProcessor`, `OutboxWorker`.
- **Database Tables**: `resource_claims`, `bookings`, `outbox_events`, `audit_events`.
- **Inbound Adapters**: Worker cron / loop.
- **Outbound Adapters**: Kysely query execution.
- **Tests**: `apps/worker/src/__tests__/hold-reaper.test.ts`, `apps/worker/src/__tests__/worker.test.ts`.
- **Status**: `AUTOMATED_VERIFIED` for hold reaper; `SCAFFOLDED` for outbox polling daemon (Confidence: HIGH).

---

## 5. Database and Migration Status

### Migration Inventory

| Migration File                     | Purpose                                                                                     | Added Schema Objects                                                                                                                                                                                                                                                                                                                                                               | Up/Down Supported     | Test Evidence                                                              | Status               |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------- | -------------------- |
| `0001_initial_schema.ts`           | Foundational schema, multi-tenancy, initial catalog, initial bookings, initial outbox       | 16 tables: `tenants`, `locations`, `app_users`, `memberships`, `customers`, `services`, `service_versions`, `resources`, `availability_rules`, `booking_quotes`, `bookings`, `resource_claims`, `idempotency_records`, `outbox_events`, `inbox_events`, `audit_events`; extensions `uuid-ossp`, `btree_gist`; rules `no_update_audit`, `no_delete_audit`                           | Yes (`up` and `down`) | `packages/db/src/__tests__/migration-lifecycle.test.ts` (Test 1)           | `AUTOMATED_VERIFIED` |
| `0002_slot_claim_rls_hardening.ts` | Concurrency hardening, GiST exclusion, composite references, RLS on 16 tables, runtime role | 3 tables: `booking_hold_snapshots`, `buyer_confirmations`, `committed_intents`; altered `resource_claims` with `starts_at`, `ends_at`, `blocking`, `hold_expires_at`; added GiST `no_overlapping_claims`, CHECK `chk_resource_claim_blocking_state`; created role `velvet_runtime`; enabled/forced RLS on 16 tables                                                                | Yes (`up` and `down`) | `packages/db/src/__tests__/migration-lifecycle.test.ts` (Tests 2, 4, 5, 7) | `AUTOMATED_VERIFIED` |
| `0003_payment_core_ledger.ts`      | PayPal payment persistence, provider journal, double-entry ledger, webhook quarantine       | 9 tables: `provider_connections`, `provider_operations`, `payment_intents`, `payment_captures`, `refund_reservations`, `webhook_quarantine`, `verified_provider_events`, `financial_journal_entries`, `financial_journal_lines`, `invoices`; view `webhook_deliveries`; triggers `trg_protect_financial_journal_*`, `trg_validate_journal_balance`; enabled/forced RLS on 9 tables | Yes (`up` and `down`) | `packages/db/src/__tests__/migration-lifecycle.test.ts` (Tests 3, 6)       | `AUTOMATED_VERIFIED` |

### Database Tables Inventory (31 Total Relations)

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;
```

#### Tenant-Scoped Tables Enforcing `FORCE ROW LEVEL SECURITY` (24 Tables)

All 24 tables have `relrowsecurity = true` AND `relforcerowsecurity = true`:

1. `audit_events`
2. `availability_rules`
3. `booking_hold_snapshots`
4. `booking_quotes`
5. `bookings`
6. `buyer_confirmations`
7. `committed_intents`
8. `customers`
9. `financial_journal_entries`
10. `financial_journal_lines`
11. `idempotency_records`
12. `invoices`
13. `locations`
14. `memberships`
15. `outbox_events`
16. `payment_captures`
17. `payment_intents`
18. `provider_connections`
19. `provider_operations`
20. `refund_reservations`
21. `resource_claims`
22. `resources`
23. `service_versions`
24. `services`
25. `verified_provider_events`

#### Global / Non-RLS Tables (6 Tables + 1 View)

- `app_users`: Global user identity bound to OIDC subjects (`relrowsecurity = false`).
- `inbox_events`: System-wide event deduplication for asynchronous consumers (`relrowsecurity = false`).
- `tenants`: Global directory of tenant accounts (`relrowsecurity = false`).
- `webhook_quarantine`: Ingress buffer for unverified raw webhooks before tenant routing (`relrowsecurity = false`).
- `kysely_migration`, `kysely_migration_lock`: Kysely migration metadata (`relrowsecurity = false`).
- `webhook_deliveries`: Read view aliasing `webhook_quarantine`.

### Crucial Security Mechanisms Verified in PostgreSQL

1. **Canonical RLS Setting**: Strictly `app.tenant_id`. All policies evaluate:
   ```sql
   USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
   WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
   ```
2. **Runtime Database Role**: `velvet_runtime` (NOLOGIN, non-owner role with `NOBYPASSRLS` default, granted `USAGE` on schema public and all privileges on tables).
3. **GiST Exclusion Constraint**:
   ```sql
   CONSTRAINT no_overlapping_claims
   EXCLUDE USING gist (
     tenant_id WITH =,
     resource_id WITH =,
     blocked_during WITH &&
   ) WHERE (blocking);
   ```
4. **Blocking-State Integrity Constraint**:
   ```sql
   CONSTRAINT chk_resource_claim_blocking_state
   CHECK ((blocking = ((state)::text = ANY (ARRAY['HELD', 'COMMITTING', 'CAPTURE_UNCERTAIN', 'CONFIRMED']))));
   ```
5. **Supporting B-tree Indexes**:
   - `resource_claim_calendar_idx` ON `resource_claims (tenant_id, resource_id, starts_at, ends_at) WHERE blocking = true`
   - `resource_claim_expiry_idx` ON `resource_claims (tenant_id, hold_expires_at) WHERE state = 'HELD'`
   - `idx_provider_operations_reconcile` ON `provider_operations (next_reconcile_at) WHERE state IN ('SENT_UNKNOWN', 'PENDING', 'RECONCILING')`
6. **Append-Only Journal Protection Triggers**:
   - `fn_protect_financial_journal_entries()`: Raises exception if `UPDATE` or `DELETE` attempted on `POSTED` entry.
   - `fn_protect_financial_journal_lines()`: Raises exception if `INSERT`, `UPDATE`, or `DELETE` attempted on lines of `POSTED` entry.
7. **Zero-Sum Ledger Balance Constraint Trigger**:
   - `trg_validate_journal_balance`: `AFTER INSERT OR UPDATE ON financial_journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_validate_journal_entry_balance()`. Verifies $\sum \text{debits} == \sum \text{credits}$ and $\text{line\_count} > 0$ on commit.

---

## 6. API Endpoint Inventory

| Method & Path | Source & Handler | Auth / Role | Idempotency | Request Schema | Response Schema | DB Transaction | External Side Effect | Status |
| `GET /health/live` | `apps/api/src/app.ts` | None | No | None | `{ status: "ok", timestamp }` | None | None | `AUTOMATED_VERIFIED` |
| `GET /health/ready` | `apps/api/src/app.ts` | None | No | None | `{ status: "ready", dependencies }` | None | None | `AUTOMATED_VERIFIED` |
| `GET /v1/services` | `apps/api/src/routes/services.ts` | Optional | No | `locationId` | `Array<ServiceDTO>` | `CatalogService` (PostgreSQL RLS) | None | `AUTOMATED_VERIFIED` |
| `GET /v1/availability` | `apps/api/src/routes/availability.ts` | Optional | No | `from`, `to`, `serviceId`, `locationId` | `AvailabilityResponseDTO` | `AvailabilityService` (PostgreSQL RLS) | None | `AUTOMATED_VERIFIED` |
| `POST /v1/booking-quotes` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | `CreateBookingQuoteInput` | `BookingQuoteDTO` | `withTenantTransaction` | None | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/prepare` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | `PrepareBookingInput` | `BookingHoldResponseDTO` | `withTenantTransaction` | Creates ES256 intent + locator | `AUTOMATED_VERIFIED` |
| `POST /v1/booking-holds` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | `PrepareBookingInput` | `BookingHoldResponseDTO` | Alias to `/prepare` | None | `AUTOMATED_VERIFIED` |
| `GET /v1/booking-approvals/:locator` | `apps/api/src/routes/bookings.ts` | None (Public locator) | No | URL param `locator` | `ApprovalDetailsDTO` | `withTenantTransaction` | Cache-Control: no-store | `AUTOMATED_VERIFIED` |
| `POST /v1/booking-approvals/:locator/confirm` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | URL param `locator` | `BuyerConfirmationDTO` | `withTenantTransaction` | Returns single-use token | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/commit` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | `CommitBookingInput` | `BookingCommitResponseDTO` | `withTenantTransaction` | Appends `outbox_events` | `AUTOMATED_VERIFIED` |
| `GET /v1/bookings/:id` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | No | URL param `id` | `BookingDTO` | `withTenantTransaction` | None | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:id/prepare-cancellation` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | No | URL param `id` | `CancellationTermsDTO` | `withTenantTransaction` | Returns signed cancellation token | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:id/cancel` | `apps/api/src/routes/bookings.ts` | Required (BUYER) | Required (`Idempotency-Key`) | `CommitCancellationInput` | `CommitCancellationResponseDTO` | `withTenantTransaction` | Dispatches policy refund, releases claim | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:id/check-in` | `apps/api/src/routes/bookings.ts` | Required (MERCHANT/SCHEDULER) | Required (`Idempotency-Key`) | URL param `id` | `AttendanceActionResponseDTO` | `withTenantTransaction` | Enforces <=2h window, transitions to CHECKED_IN | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:id/complete` | `apps/api/src/routes/bookings.ts` | Required (MERCHANT) | Required (`Idempotency-Key`) | URL param `id` | `AttendanceActionResponseDTO` | `withTenantTransaction` | Releases claim, enables balance invoice | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:id/no-show` | `apps/api/src/routes/bookings.ts` | Required (MERCHANT) | Required (`Idempotency-Key`) | URL param `id` | `AttendanceActionResponseDTO` | `withTenantTransaction` | Enforces 15m grace period, releases claim | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:bookingId/payment-order` | `apps/api/src/routes/payments.ts` | Required (BUYER) | Required (`Idempotency-Key`) | URL param `bookingId` | `PaymentOrderResponseDTO` | `withTenantTransaction` | Calls PayPal `POST /v2/checkout/orders` | `AUTOMATED_VERIFIED` |
| `POST /v1/payments/:paymentIntentId/capture` | `apps/api/src/routes/payments.ts` | Required (BUYER) | Required (`Idempotency-Key`) | URL param `paymentIntentId` | `PaymentCaptureResponseDTO` | `withTenantTransaction` | Calls PayPal `POST /v2/checkout/orders/{id}/capture` | `AUTOMATED_VERIFIED` |
| `GET /v1/operations/:operationId` | `apps/api/src/routes/payments.ts` | Required (BUYER) | No | URL param `operationId` | `OperationStatusDTO` | `withTenantTransaction` | None | `AUTOMATED_VERIFIED` |
| `POST /v1/captures/:captureId/refunds` | `apps/api/src/routes/payments.ts` | Required (MERCHANT/ADMIN) | Required (`Idempotency-Key`) | `RefundPaymentInput` | `RefundResponseDTO` | `withTenantTransaction` (FOR UPDATE) | Calls PayPal `POST /v2/payments/captures/{id}/refund` | `AUTOMATED_VERIFIED` |
| `POST /v1/bookings/:bookingId/balance-invoice` | `apps/api/src/routes/payments.ts` | Required (MERCHANT) | Required (`Idempotency-Key`) | URL param `bookingId` | `InvoiceResponseDTO` | `withTenantTransaction` | Calls PayPal `POST /v2/invoicing/invoices` | `AUTOMATED_VERIFIED` |
| `POST /v1/webhooks/paypal/:connectionKey` | `apps/api/src/routes/payments.ts` | Signature header verified | No | Raw Buffer (256 KiB max) | `{ received: true }` | Raw quarantine insert | Calls PayPal `POST /v1/notifications/verify-webhook-signature` | `AUTOMATED_VERIFIED` |
| `POST /v1/risk/evaluate` | `apps/api/src/routes/risk.ts` | Required (SCHEDULER) | No | `RiskEvaluationInput` | `RiskEvaluationResponseDTO` | In-memory evaluation | None | `AUTOMATED_VERIFIED` |

---

## 7. Booking Workflow

### 13 Workflows Trace

1. **Availability Search**: Handled by `GET /v1/availability` -> `AvailabilityService.getAvailableSlots()`. Queries PostgreSQL `availability_rules` and `resources` for the tenant/location, subtracts active blocking `resource_claims` with half-open intervals `[starts_at, ends_at)`, incorporates service buffers, handles DST and IANA time zones authoritatively, and outputs UTC ISO strings and schedule revisions without mock fill scores.
2. **Quote Creation**: Handled by `POST /v1/booking-quotes` -> `BookingService.createQuote()`. Queries published `service_versions` and creates an immutable snapshot of pricing (deposit + total), service version, and cancellation policy with a 5-minute TTL. Protected by `Idempotency-Key`.
3. **Hold Creation**: Handled by `POST /v1/bookings/prepare` -> `BookingService.prepareBooking()`. Inserts `bookings` in `HELD` state and `resource_claims` in `HELD` state with `blocking: true`. Protected by GiST constraint `no_overlapping_claims` and `Idempotency-Key`.
4. **Signed Intent Creation**: Inside `BookingService.prepareBooking()`. Generates an ES256 IEEE-P1363 JWS containing canonical SHA-256 hash of service, schedule, pricing, actor, and tenant. Signed via `jose.CompactSign`.
5. **Approval Locator**: Inside `BookingService.prepareBooking()`. Generates a 128-bit unguessable random locator string `loc_<hex>` stored in `buyer_confirmations`. Provides read-only terms inspection via `GET /v1/booking-approvals/:locator`.
6. **Buyer Confirmation**: Handled by `POST /v1/booking-approvals/:locator/confirm` -> `BookingService.confirmApproval()`. Generates a 256-bit cryptographically secure token `conf_<hex>`, persists its SHA-256 hash in `buyer_confirmations`, and returns raw token to buyer. Protected by `Idempotency-Key`.
7. **Commit Operation**: Handled by `POST /v1/bookings/commit` -> `BookingService.commitBooking()`. Verifies signed JWS intent, verifies buyer confirmation token, marks token consumed atomically (`consumed_at = clock_timestamp()`), records `committed_intents`, transitions booking to `COMMITTING`, appends `outbox_events`. Protected by `Idempotency-Key`.
8. **Hold Expiration**: Executed by `HoldReaperProcessor.reapOnce()`. Selects expired claims with `FOR UPDATE SKIP LOCKED` where `hold_expires_at <= clock_timestamp()`, sets claim state to `EXPIRED`, `blocking: false`, transitions booking to `EXPIRED`.
9. **Booking Retrieval**: Handled by `GET /v1/bookings/:id`. Queries `bookings` table scoped to `app.tenant_id`.
10. **Cancellation Lifecycle**: Fully implemented via `prepareCancellation` and `commitCancellation`. `prepareCancellation` evaluates policy rules against appointment start time, determining refund eligibility and generating a tamper-proof signed cancellation token. `commitCancellation` verifies the token under row lock, handles uncertain captures (`CANCEL_REQUESTED` until reconciled), reserves and dispatches policy refunds via `PaymentService.refundPayment()`, releases resource claims (`blocking: false`), and emits audit/outbox events. Protected by `Idempotency-Key`.
11. **Rescheduling**: **DEFERRED**. Spec FR-020; deferred to Epic 5.
12. **Waitlist / Released-Slot Refill**: **DEFERRED**. Spec FR-021; deferred to Epic 5.
13. **Attendance / Check-In / Completion / No-Show**: Fully implemented merchant routes:
    - `POST /v1/bookings/:id/check-in`: Enforces merchant/scheduler role and <=2h check-in window before appointment start; updates status to `CHECKED_IN`.
    - `POST /v1/bookings/:id/complete`: Enforces merchant role; updates status to `COMPLETED`, releases resource claim, authorizes single balance invoice creation.
    - `POST /v1/bookings/:id/no-show`: Enforces merchant role and 15-minute grace period after appointment start; updates status to `NO_SHOW` and releases resource claim.
      All transitions protected by `Idempotency-Key`.

### Booking State Machine

```mermaid
stateDiagram-v2
    [*] --> DRAFT : Quote Created
    DRAFT --> HELD : prepareBooking() [Hold Claimed]
    HELD --> EXPIRED : hold_expires_at passed [HoldReaper]
    HELD --> COMMITTING : commitBooking() [Intent + Confirmation Valid]
    COMMITTING --> REQUIRES_PAYER_ACTION : createDepositOrder()
    REQUIRES_PAYER_ACTION --> CAPTURE_IN_FLIGHT : capturePayment() dispatched
    REQUIRES_PAYER_ACTION --> PAYMENT_WINDOW_EXPIRED : payment_expires_at passed
    CAPTURE_IN_FLIGHT --> CAPTURED : PayPal returns COMPLETED
    CAPTURE_IN_FLIGHT --> CAPTURE_UNCERTAIN : Timeout / 5xx / PENDING
    CAPTURE_UNCERTAIN --> CAPTURED : Webhook COMPLETED / Reconcile
    CAPTURE_UNCERTAIN --> PAYMENT_FAILED : Webhook DENIED / Reconcile
    CAPTURED --> CONFIRMED : Booking Finalized
    CONFIRMED --> CANCELLED : Cancellation / Refund
    EXPIRED --> [*]
    PAYMENT_FAILED --> [*]
    CONFIRMED --> [*]
```

### Booking Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Buyer as Buyer / Agent
    participant Web as apps/web
    participant API as apps/api
    participant BookSvc as BookingService
    participant DB as PostgreSQL 17 (RLS)

    Buyer->>Web: Select Service & Time Slot
    Web->>API: POST /v1/booking-quotes
    API->>BookSvc: createQuote()
    BookSvc->>DB: INSERT booking_quotes
    DB-->>BookSvc: Quote created (5 min TTL)
    BookSvc-->>API: Quote DTO
    API-->>Web: Quote DTO

    Buyer->>Web: Request Hold
    Web->>API: POST /v1/bookings/prepare
    API->>BookSvc: prepareBooking()
    Note over BookSvc,DB: withTenantTransaction(app.tenant_id)
    BookSvc->>DB: INSERT resource_claims (blocking=true)
    Note over DB: GiST exclusion verifies no overlap
    BookSvc->>DB: INSERT booking_hold_snapshots
    BookSvc->>DB: INSERT buyer_confirmations (locator, expires_at)
    BookSvc-->>API: JWS Intent + Approval Locator
    API-->>Web: Hold Created (HELD)

    Buyer->>Web: Open Approval Locator
    Web->>API: GET /v1/booking-approvals/:locator
    API-->>Web: Display Terms (Read-Only)
    Buyer->>Web: Click "Accept Terms"
    Web->>API: POST /v1/booking-approvals/:locator/confirm
    API->>BookSvc: confirmApproval()
    BookSvc->>DB: Update token_hash in buyer_confirmations
    BookSvc-->>API: Single-use confirmationToken
    API-->>Web: confirmationToken

    Buyer->>Web: Confirm Booking
    Web->>API: POST /v1/bookings/commit (Idempotency-Key)
    API->>BookSvc: commitBooking(intent, confirmationToken)
    Note over BookSvc,DB: Atomic Commit Transaction
    BookSvc->>BookSvc: Verify JWS (typ, alg, kid, hash)
    BookSvc->>DB: UPDATE buyer_confirmations SET consumed_at=NOW()
    BookSvc->>DB: INSERT committed_intents (intent_jti)
    BookSvc->>DB: UPDATE bookings SET status='COMMITTING'
    BookSvc->>DB: INSERT outbox_events ('booking.committing')
    BookSvc-->>API: Status COMMITTING
    API-->>Web: Success COMMITTING
```

---

## 8. PayPal and Financial Workflow

### 15 Financial Workflows Trace

1. **OAuth Token Acquisition & Cache**: Handled in `PayPalHttpClient.getAccessToken()`. Acquires Bearer token via `POST /v1/oauth2/token` using HTTP Basic auth. Caches token in memory with 60-second safety buffer; concurrent calls await existing promise to prevent token stampedes. Rejects live URLs. Tests: `packages/integrations-paypal/src/__tests__/paypal.test.ts` (Tests 3, 4).
2. **Create Orders v2 Deposit Order**: Handled by `POST /v1/bookings/:bookingId/payment-order` -> `PaymentService.createDepositOrder()`. Records `provider_operations` row in `PREPARED` state, posts to PayPal `POST /v2/checkout/orders` with stable `PayPal-Request-Id`, binds order ID to `payment_intents` in `REQUIRES_PAYER_ACTION` state.
3. **PayPal JS SDK v6 Buyer Approval**: Handled in `apps/web/src/components/PayPalButton.tsx`. Loads official v6 SDK script (`https://www.sandbox.paypal.com/web-sdk/v6/core`), initializes `createPayPalOneTimePaymentSession`, opens native modal. On buyer approval, client invokes backend capture endpoint (client never captures directly).
4. **Backend Capture**: Handled by `POST /v1/payments/:paymentIntentId/capture` -> `PaymentService.capturePayment()`. Records `provider_operations` row in `DISPATCHING`, calls PayPal `POST /v2/checkout/orders/{id}/capture` with stable request ID.
5. **Capture Pending / Unknown**: If PayPal returns HTTP 201 with capture state `PENDING`, or on network timeout / HTTP 5xx, `PaymentService.capturePayment()` sets `payment_captures` to `PENDING`, sets `bookings` to `CAPTURE_UNCERTAIN`, keeps `resource_claims` as `blocking: true`, and returns HTTP 202 with status polling URL.
6. **Reconciliation**: Background or on-demand query via `GET /v1/operations/:operationId` and `paymentService.reconcileOperation()`. Retrieves authoritative PayPal order/capture state, updates local records without duplicate ledger postings.
7. **Webhook Quarantine**: Handled by `POST /v1/webhooks/paypal/:connectionKey`. Fastify route with raw Buffer parser and 256 KiB limit (`body_bytes_length <= 262144`). Inserts raw event into `webhook_quarantine` in `UNVERIFIED` state.
8. **Signature Verification**: Invokes `PayPalSandboxAdapter.verifyWebhookSignature()` calling PayPal `POST /v1/notifications/verify-webhook-signature`. Validates certificate URL strictly belongs to `*.paypal.com` to prevent SSRF attacks.
9. **Verified-Event Deduplication**: On signature success, event is inserted into `verified_provider_events` with unique constraint `(environment, provider_connection_id, provider_event_id)`. Poisoned/unverified webhooks remain quarantined as `REJECTED` and cannot suppress legitimate webhooks.
10. **Out-of-Order Reduction**: Reducer in `PaymentService` processes events based on state priority. `PAYMENT.CAPTURE.COMPLETED` confirms booking and posts ledger even if arrival precedes capture HTTP response; `CHECKOUT.PAYMENT-APPROVAL.REVERSED` or `PAYMENT.CAPTURE.DENIED` releases blocking claim and marks `PAYMENT_FAILED`.
11. **Partial / Full Refund**: Handled by `POST /v1/captures/:captureId/refunds` -> `PaymentService.refundPayment()`. Locks `payment_captures` row using `FOR UPDATE`, enforces $\text{requested} \le \text{captured} - (\text{completed} + \text{pending} + \text{unknown})$, records `refund_reservations` row, calls PayPal `POST /v2/payments/captures/{id}/refund`, posts balanced refund ledger entry.
12. **Unknown Refund Reconciliation**: Implemented via `PaymentService.reconcileUnknownRefund()`. Polls PayPal capture/refund details under row lock; recovers status without releasing refundable capacity on unknown network outcomes.
13. **External / Dashboard Refund**: Detected when `PAYMENT.CAPTURE.REFUNDED` webhook arrives without prior local refund reservation. Reducer inserts `refund_reservations` as `COMPLETED` and posts balanced debit/credit reversal to the double-entry journal.
14. **Financial Journal Posting**: Double-entry ledger entries created in `DRAFT`, populated with lines, and updated to `POSTED`. Constraint trigger `trg_validate_journal_balance` verifies zero-sum balance ($\sum \text{debits} == \sum \text{credits}$) before commit. Triggers block any update/delete of posted entries.
15. **Balance Invoice Creation / Sending**: Handled by `POST /v1/bookings/:bookingId/balance-invoice` -> `PaymentService.createBalanceInvoice()`. Creates PayPal Invoicing v2 draft (`POST /v2/invoicing/invoices`), sends invoice, stores non-authoritative projection in `invoices` table. Invoice failure does not alter canonical booking/payment state.

### Explicit Financial Guarantees Verified

- **Booking confirms ONLY on capture `COMPLETED`**: Verified. Capture `PENDING` leaves booking in `CAPTURE_UNCERTAIN`.
- **`PENDING` remains uncertain and blocking**: Verified. `resource_claims.blocking` remains `true`.
- **Timeout / 5xx remains unknown**: Verified. Recorded as `SENT_UNKNOWN` in `provider_operations`; claim remains blocking.
- **Refund unknown state retains capacity**: Verified. `refund_reservations` in `UNKNOWN` state count against available refundable balance until reconciled.
- **Invoice is non-authoritative**: Verified. Invoicing failures return Problem Details but leave payment and booking records untouched.
- **Live PayPal is rejected**: Verified. `PayPalHttpClient` startup validation throws error if environment is `live`.
- **Secrets remain server-side**: Verified. Client components only receive `orderId` and client ID; client secret is strictly server-only.

### Payment Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Buyer as Buyer
    participant Web as apps/web (PayPal JS SDK v6)
    participant API as apps/api
    participant PaySvc as PaymentService
    participant DB as PostgreSQL 17
    participant PayPal as PayPal Sandbox API v2

    Buyer->>Web: Click "Pay Deposit"
    Web->>API: POST /v1/bookings/:id/payment-order
    API->>PaySvc: createDepositOrder()
    PaySvc->>DB: INSERT provider_operations (PREPARED)
    PaySvc->>PayPal: POST /v2/checkout/orders (PayPal-Request-Id)
    PayPal-->>PaySvc: 201 Created (orderId: 26B9...125W)
    PaySvc->>DB: UPDATE payment_intents (REQUIRES_PAYER_ACTION)
    PaySvc-->>API: orderId
    API-->>Web: orderId

    Web->>PayPal: SDK opens buyer approval modal
    Buyer->>PayPal: Log in and approve payment
    PayPal-->>Web: onApprove() triggered

    Web->>API: POST /v1/payments/:id/capture
    API->>PaySvc: capturePayment()
    PaySvc->>DB: INSERT provider_operations (DISPATCHING)
    PaySvc->>PayPal: POST /v2/checkout/orders/{id}/capture
    PayPal-->>PaySvc: 201 Created (status: COMPLETED, captureId: 91P4...790B)

    Note over PaySvc,DB: Atomic Finalization & Ledger Transaction
    PaySvc->>DB: INSERT payment_captures (COMPLETED)
    PaySvc->>DB: UPDATE bookings SET status='CONFIRMED'
    PaySvc->>DB: UPDATE resource_claims SET state='CONFIRMED', blocking=true
    PaySvc->>DB: INSERT financial_journal_entries (DRAFT)
    PaySvc->>DB: INSERT financial_journal_lines (Debit ASSET, Credit LIABILITY)
    PaySvc->>DB: UPDATE financial_journal_entries SET status='POSTED'
    Note over DB: Constraint trigger validates debits == credits
    PaySvc-->>API: Capture Success (CONFIRMED)
    API-->>Web: Booking Confirmed!
```

---

## 9. Real Sandbox Evidence

All evidence below is drawn strictly from sanitized repository records in `docs/implementation-progress.md` and `docs/runbooks/paypal-sandbox-e2e.md`. All identifiers have been redacted to preserve public confidentiality while proving execution:

| Item                          | Requirement                               | Evidence Found                                                                                                                                                                                                             | Status               |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **Real Order Created**        | Orders v2 order created on sandbox        | Order ID `26B9…125W` ($20.00 USD deposit). Provider operation recorded in `provider_operations`.                                                                                                                           | `REAL_E2E_VERIFIED`  |
| **Manual Buyer Approval**     | Interactive buyer login and approval      | Dedicated sandbox personal account approved payment via PayPal Sandbox modal.                                                                                                                                              | `REAL_E2E_VERIFIED`  |
| **Backend Capture**           | Authoritative capture reaches `COMPLETED` | Capture ID `91P4…790B` returned status `COMPLETED`. Booking confirmed in DB.                                                                                                                                               | `REAL_E2E_VERIFIED`  |
| **Real Webhook Verified**     | Real webhook signature verified           | Transmission ID `32cd…6c2c`, Event ID `WH-7Y72…7105M`, certificate URL `https://api.sandbox.paypal.com/...`, verification result `SUCCESS`.                                                                                | `REAL_E2E_VERIFIED`  |
| **Partial Refund**            | Authoritative refund on captured payment  | Refund ID `7M63…105F` ($5.00 USD), status `COMPLETED`. Available balance reduced from $20.00 to $15.00.                                                                                                                    | `REAL_E2E_VERIFIED`  |
| **Journal Entries Balanced**  | Double-entry zero-sum balance verified    | Deposit: Debit `ASSET:PAYPAL_CLEARING` 2000 minor, Credit `LIABILITY:CUSTOMER_DEPOSIT` 2000 minor ($0.00 net). Refund: Debit `LIABILITY:CUSTOMER_DEPOSIT` 500 minor, Credit `ASSET:PAYPAL_CLEARING` 500 minor ($0.00 net). | `REAL_E2E_VERIFIED`  |
| **Fee Breakdown Parsing**     | Settlement arithmetic confirmed           | `sellerReceivableBreakdown`: $18.73 net + $1.27 fee = $20.00 gross (1873 + 127 = 2000 minor units). Refund fee retention: $0.00 fee refunded, $5.00 net debited.                                                           | `AUTOMATED_VERIFIED` |
| **Sanitization & Redaction**  | No credentials, tokens, or PII exposed    | 0 passwords, 0 client secrets, 0 buyer addresses or real names logged or committed. Complete IDs redacted.                                                                                                                 | `AUTOMATED_VERIFIED` |
| **Temporary Ingress Cleanup** | Tunnels and webhook registrations deleted | Cloudflare tunnel terminated (task-3668 killed; 0 orphan processes). Webhook `5FN14610…` deleted via PayPal API (HTTP 204).                                                                                                | `AUTOMATED_VERIFIED` |
| **Stable Hosted Webhook**     | Permanent public webhook endpoint         | None. Staging environment on Render not yet deployed.                                                                                                                                                                      | `ABSENT`             |

---

## 10. Agent and AI Interfaces

| Component                              | Status               | Confidence | Implementation Evidence                                                   | Verification Evidence                                         | Remaining Gap                                                        |
| -------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Tool Registry**                      | `AUTOMATED_VERIFIED` | HIGH       | `packages/tool-registry/src/registry.ts`                                  | `packages/tool-registry/src/__tests__/registry.test.ts`       | In-memory registry only.                                             |
| **MCP Transport (Streamable HTTP)**    | `SCAFFOLDED`         | HIGH       | Spec ADR and contract types defined                                       | No listener in `apps/api/src/app.ts`                          | Need Fastify route mounted to handle Streamable HTTP protocol.       |
| **MCP Authentication & Authorization** | `SCAFFOLDED`         | HIGH       | OAuth 2.1 scopes defined in contracts (`booking:read`, `booking:write`)   | Tested in Abuse Lab SEC-004                                   | Fastify plugin verifying MCP OAuth bearer tokens needed.             |
| **MCP Protocol Revision (2026-07-28)** | `DOCUMENTED_ONLY`    | HIGH       | Referenced in `SPEC_V1_1_AMENDMENT.md` Section E.2                        | Grep for `2026-07-28` shows docs only                         | Formal MCP JSON-RPC protocol negotiation not implemented.            |
| **`server/discover`**                  | `ABSENT`             | HIGH       | None                                                                      | None                                                          | Discovery metadata endpoint not built.                               |
| **`tools/list` and `tools/call`**      | `SCAFFOLDED`         | HIGH       | Methods exist on `ToolRegistry` class                                     | Unit tests pass on class instance                             | Not exposed over network transport.                                  |
| **Prepare / Commit Tools**             | `SCAFFOLDED`         | HIGH       | `prepare_booking` enabled; `commit_booking` explicitly `enabled: false`   | Calling `commit_booking` throws error per design              | Epic 4 must implement secure browser-assisted commit execution.      |
| **URL-mode Approval / Elicitation**    | `AUTOMATED_VERIFIED` | HIGH       | `GET /v1/booking-approvals/:locator`, `POST .../confirm`                  | `packages/application/src/__tests__/booking-security.test.ts` | UI page needs final styling.                                         |
| **WebMCP Registration**                | `ABSENT`             | HIGH       | None in `apps/web`                                                        | None                                                          | Need `document.modelContext.registerTool()` progressive enhancement. |
| **WebMCP Security Hints**              | `ABSENT`             | HIGH       | None                                                                      | None                                                          | Origin allowlist and read-only annotations needed.                   |
| **In-page Ask AI**                     | `ABSENT`             | HIGH       | None in `apps/web`                                                        | None                                                          | Need React chat drawer with streaming tool execution.                |
| **Model-Provider Adapter**             | `ABSENT`             | HIGH       | None                                                                      | None                                                          | Vercel AI SDK or Google Gemini SDK integration not implemented.      |
| **Tool Allowlist**                     | `AUTOMATED_VERIFIED` | HIGH       | Enforced in `ToolRegistry` and tested in Abuse Lab SEC-006                | `apps/abuse-lab/src/scenarios.ts`                             | Dynamic per-tenant tool policy.                                      |
| **Tool-Call / Token Budgets**          | `AUTOMATED_VERIFIED` | HIGH       | Budget limits defined in `contracts` and evaluated in Abuse Lab           | Abuse Lab SEC-003, SEC-005                                    | Runtime middleware enforcement.                                      |
| **Prompt-Injection Quarantine**        | `AUTOMATED_VERIFIED` | HIGH       | Tested in Abuse Lab SEC-007, SEC-008, SEC-015                             | All Abuse Lab tests pass                                      | Real LLM input scrubbing filter.                                     |
| **Separation of Prose & Tool Output**  | `AUTOMATED_VERIFIED` | HIGH       | Enforced by dual-token architecture (intent + confirmation)               | Abuse Lab SEC-015                                             | Model prose cannot trigger mutations.                                |
| **Human Approval Boundary**            | `AUTOMATED_VERIFIED` | HIGH       | Interactive approval locator separates agent hold from buyer confirmation | Tested in booking security tests                              | Final UX polish on approval page.                                    |

---

## 11. Forecasting Status

| Capability                    | Status               | Confidence | Code Path                                    | Data Source                                                                              | Verification Evidence                                    | UI Integration |
| ----------------------------- | -------------------- | ---------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------- |
| **No-Show Model**             | `AUTOMATED_VERIFIED` | HIGH       | `packages/forecasting/src/models.ts:18`      | In-memory feature vectors (`leadTimeHours`, `weekday`, `depositTier`, `rescheduleCount`) | `packages/forecasting/src/__tests__/forecasting.test.ts` | None           |
| **Slot-Fill Model**           | `AUTOMATED_VERIFIED` | HIGH       | `packages/forecasting/src/models.ts:66`      | In-memory feature vectors (`leadTimeHours`, `weekday`, `hourOfDay`)                      | `packages/forecasting/src/__tests__/forecasting.test.ts` | None           |
| **Revenue / Cash Forecast**   | `ABSENT`             | HIGH       | Not implemented                              | None                                                                                     | None                                                     | None           |
| **Brier Score Calculation**   | `AUTOMATED_VERIFIED` | HIGH       | `packages/forecasting/src/metrics.ts:1`      | Prediction probabilities vs actual binary outcomes                                       | `packages/forecasting/src/__tests__/forecasting.test.ts` | None           |
| **Calibration Error**         | `ABSENT`             | HIGH       | Not implemented                              | None                                                                                     | None                                                     | None           |
| **WAPE Metric Calculation**   | `AUTOMATED_VERIFIED` | HIGH       | `packages/forecasting/src/metrics.ts:12`     | Actual vs forecast series                                                                | `packages/forecasting/src/__tests__/forecasting.test.ts` | None           |
| **Seed-Data Generation**      | `ABSENT`             | HIGH       | None                                         | None                                                                                     | None                                                     | None           |
| **Feature Snapshots (DB)**    | `ABSENT`             | HIGH       | Zero forecast tables in migrations 0001–0003 | None                                                                                     | None                                                     | None           |
| **Drift / Freshness Monitor** | `ABSENT`             | HIGH       | None                                         | None                                                                                     | None                                                     | None           |
| **Deposit-Tier Mapping**      | `AUTOMATED_VERIFIED` | HIGH       | `packages/forecasting/src/models.ts:28`      | Static risk threshold mapping                                                            | `packages/forecasting/src/__tests__/forecasting.test.ts` | None           |
| **Scheduler Integration**     | `ABSENT`             | HIGH       | None                                         | None                                                                                     | None                                                     | None           |
| **UI Visualization**          | `ABSENT`             | HIGH       | None in `apps/web`                           | None                                                                                     | None                                                     | None           |

> [!NOTE]
> `@velvetai/forecasting` is a mathematically verified statistical library. It is NOT yet a production machine learning pipeline and has zero database or UI integration.

---

## 12. Web Application Status

| Page / Component            | Source Path                                | API Dependencies                                         | Automated Tests                                                    | E2E Evidence                                        | Status               |
| --------------------------- | ------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- | -------------------- |
| **Home Page**               | `apps/web/src/pages/HomePage.tsx`          | None                                                     | `apps/web/src/__tests__/app.test.ts`                               | Renders hero, geometry, runtime policy              | `AUTOMATED_VERIFIED` |
| **Booking Page**            | `apps/web/src/pages/BookingPage.tsx`       | `POST /v1/booking-quotes`, `POST /v1/bookings/prepare`   | `apps/web/src/__tests__/app.test.ts`                               | Renders booking simulator                           | `AUTOMATED_VERIFIED` |
| **Schedule Page**           | `apps/web/src/pages/SchedulePage.tsx`      | `GET /v1/availability`                                   | `apps/web/src/__tests__/app.test.ts`                               | Custom React state countdown simulator              | `AUTOMATED_VERIFIED` |
| **Policy Page**             | `apps/web/src/pages/PolicyPage.tsx`        | None (Static)                                            | `apps/web/src/__tests__/app.test.ts`                               | Renders cancellation & refund rules                 | `AUTOMATED_VERIFIED` |
| **Status Page**             | `apps/web/src/pages/StatusPage.tsx`        | `GET /health/live`, `GET /health/ready`                  | `apps/web/src/__tests__/app.test.ts`                               | Renders backend health checks                       | `AUTOMATED_VERIFIED` |
| **PayPal Button Component** | `apps/web/src/components/PayPalButton.tsx` | `POST .../payment-order`, `POST .../capture`             | `apps/web/src/components/__tests__/PayPalButton.test.ts` (5 tests) | Real Sandbox Order `26B9…125W`, Capture `91P4…790B` | `REAL_E2E_VERIFIED`  |
| **Approval Flow Page**      | `apps/web/src/pages/BookingPage.tsx`       | `GET /v1/booking-approvals/:locator`, `POST .../confirm` | Included in booking simulator tests                                | Tested in browser subagent                          | `AUTOMATED_VERIFIED` |
| **Bryntum Scheduler**       | None                                       | None                                                     | None                                                               | None                                                | `ABSENT`             |
| **Abuse Lab UI**            | None                                       | None                                                     | None                                                               | None                                                | `ABSENT`             |
| **Judge Reset UI**          | None                                       | None                                                     | None                                                               | None                                                | `ABSENT`             |

### Web Readiness Summary

```text
Local website readiness: AUTOMATED_VERIFIED
Hosted website readiness: ABSENT
Judge workflow readiness: ABSENT
```

---

## 13. Worker and Event Delivery Status

| Worker Component               | Implementation File                           | Database Query / Mechanism                                                                                                                                | Delivery Guarantee                                                                             | Status                                                                  |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Hold Reaper Processor**      | `apps/worker/src/hold-reaper.ts`              | `SELECT ... FROM resource_claims WHERE state = 'HELD' AND hold_expires_at <= clock_timestamp() LIMIT $1 FOR UPDATE SKIP LOCKED`                           | At-least-once scanning; idempotent claim release and booking expiration in single transaction. | `AUTOMATED_VERIFIED`                                                    |
| **Outbox Processor**           | `apps/worker/src/outbox-processor.ts`         | `OutboxProcessor` class supports `claimEvents()`, `markProcessed()`, `recordInboxProcessed()`. Default instance in `index.ts` uses `InMemoryOutboxStore`. | At-least-once processing + consumer inbox deduplication.                                       | `SCAFFOLDED` (PostgreSQL outbox polling daemon not wired in `index.ts`) |
| **Inbox Deduplication**        | `apps/worker/src/outbox-processor.ts`         | `inbox_events` table in PostgreSQL; in-memory set in unit store.                                                                                          | Effect-once side effects via unique constraint `uq_inbox_consumer_event`.                      | `AUTOMATED_VERIFIED`                                                    |
| **BullMQ Integration**         | None                                          | Redis queue not implemented.                                                                                                                              | None. Amendment H.1 explicitly defers BullMQ in favor of PostgreSQL outbox.                    | `DEFERRED`                                                              |
| **Payment Reconciliation Job** | `packages/application/src/payment-service.ts` | `idx_provider_operations_reconcile` index on `provider_operations(next_reconcile_at)`.                                                                    | Callable on-demand; background cron loop not spawned.                                          | `SCAFFOLDED`                                                            |

### Genuine Delivery Guarantee

```text
at-least-once outbox storage + effect-once durable side effects via PostgreSQL unique constraints and inbox records
```

---

## 14. Security Control Status

| # | Control | Location | Test / Evidence | Status | Remaining Risk |
|---|---|---|---|---|---|---|
| 1 | Tenant Isolation | `packages/db/src/client.ts:33`, `0002_slot_claim_rls_hardening.ts` | `packages/db/src/__tests__/rls-isolation.test.ts` (6 tests) | `AUTOMATED_VERIFIED` | Low. Enforced by PostgreSQL RLS. |
| 2 | RLS Connection Pool Safety | `withTenantTransaction` sets `app.tenant_id` with 3rd param `true` (local to transaction) | `packages/db/src/__tests__/rls-isolation.test.ts` (pool size 1 test) | `AUTOMATED_VERIFIED` | Low. Context cleared on commit/rollback. |
| 3 | RBAC & Role Versioning | `apps/api/src/plugins/auth.ts`, `memberships` table | `packages/domain/src/__tests__/domain.test.ts` | `AUTOMATED_VERIFIED` | Role revocation cache invalidation. |
| 4 | MFA / Step-up Support | Defined in contracts (`auth_time`, `amr: ['mfa']`) | Abuse Lab SEC-014 | `SCAFFOLDED` | Real IdP MFA challenge integration. |
| 5 | CSRF Protection | Fastify API is Bearer-token / JWS based; no cookie-based ambient credentials | Architecture review | `AUTOMATED_VERIFIED` | None for Bearer auth API. |
| 6 | CORS / Origin Validation | `apps/api/src/app.ts:47` allowlists `WEB_BASE_URL` | Fastify CORS tests | `AUTOMATED_VERIFIED` | Dynamic origins for multitenancy. |
| 7 | CSP Headers | Defined in web deployment spec | Abuse Lab SEC-005 | `SCAFFOLDED` | Fastify helmet headers not mounted. |
| 8 | Signed Intent (ES256 JWS) | `packages/application/src/booking-intent.ts` | `packages/application/src/__tests__/booking-security.test.ts` (13 JWS attack tests) | `AUTOMATED_VERIFIED` | Key rotation runbook. |
| 9 | One-Time Confirmation Token | `packages/application/src/booking-service.ts`, `buyer_confirmations` | `packages/application/src/__tests__/booking-security.test.ts` (Tests 15, 16) | `AUTOMATED_VERIFIED` | None. 256-bit entropy, hashed in DB. |
| 10 | Token Hashing | `token_hash = sha256(confirmationToken)` in PostgreSQL | `booking-security.test.ts` | `AUTOMATED_VERIFIED` | None. Raw token never persisted. |
| 11 | Replay Protection | `committed_intents` table + atomic `consumed_at` check | Abuse Lab SEC-001, SEC-002, SEC-003 | `AUTOMATED_VERIFIED` | None. 100 concurrent replays produce 1 winner / 99 409s. |
| 12 | Duplicate JSON Keys | `apps/api/src/app.ts:29` Content-Type parser rejects duplicate keys before parsing | `apps/api/src/__tests__/routes.test.ts`, Abuse Lab SEC-007 | `AUTOMATED_VERIFIED` | None. Fastify returns HTTP 400 Problem Details. |
| 13 | Unicode Canonicalization | `packages/application/src/canonicalizer.ts` (RFC 8785 JSON canonicalization) | `packages/application/src/__tests__/canonicalizer.test.ts`, Abuse Lab SEC-008 | `AUTOMATED_VERIFIED` | None. Normalizes NFC/NFD representations. |
| 14 | Money Precision | `MoneyMinor` (bigint), zero-decimal (`JPY`) & three-decimal (`KWD`) validation | `packages/contracts/src/__tests__/money-serialization.test.ts`, Abuse Lab SEC-009, SEC-010 | `AUTOMATED_VERIFIED` | Floating-point conversion bugs eliminated. |
| 15 | Prompt Injection | Evaluated in Abuse Lab scenarios | Abuse Lab SEC-006, SEC-007, SEC-008 | `AUTOMATED_VERIFIED` | Real LLM output filter in Epic 4. |
| 16 | XSS / Output Escaping | React 19 automatic escaping; RFC 9457 JSON Problem Details | Web component tests | `AUTOMATED_VERIFIED` | Minimal risk on JSON APIs. |
| 17 | CSV Injection | Not applicable (no CSV export endpoint currently exists) | N/A | `DEFERRED` | Must sanitize formula characters (`=`, `+`, `-`, `@`) when CSV export added. |
| 18 | Webhook Poisoning | `webhook_quarantine` table; signature verification before canonical insertion | `packages/application/src/__tests__/payment-lifecycle.test.ts` (Test 14) | `AUTOMATED_VERIFIED` | None. Unverified webhooks cannot suppress verified events. |
| 19 | SSRF Certificate Fetching | `PayPalSandboxAdapter` validates certificate URL strictly matches `^https://api(\.sandbox)?\.paypal\.com/` | `packages/integrations-paypal/src/__tests__/paypal.test.ts` (Test 15), Abuse Lab SEC-026 | `AUTOMATED_VERIFIED` | None. Blocks internal network scans. |
| 20 | Rate Limiting | In-memory token bucket in contracts | Abuse Lab SEC-003 | `SCAFFOLDED` | Fastify rate-limit plugin not mounted. |
| 21 | Secret / PII Redaction | `packages/observability/src/logger.ts` redact rules | `packages/observability/src/__tests__/env.test.ts` | `AUTOMATED_VERIFIED` | Complete redaction of authorization headers, passwords, secrets. |
| 22 | Audit Immutability | `audit_events` table rules `no_update_audit` and `no_delete_audit` | Migration 0001 lifecycle test | `AUTOMATED_VERIFIED` | Database rules prevent UPDATE/DELETE. |
| 23 | Journal Immutability | Triggers `fn_protect_financial_journal_entries` and `fn_protect_financial_journal_lines` | `packages/db/src/__tests__/migration-lifecycle.test.ts` (Test 6) | `AUTOMATED_VERIFIED` | Explicit exceptions raised on POSTED mutation. |
| 24 | Abuse Lab | `apps/abuse-lab` executes 28 deterministic attack scenarios | `apps/abuse-lab/src/__tests__/runner.test.ts` (29 passed tests) | `AUTOMATED_VERIFIED` | Suite must run in CI pipeline. |

---

## 15. Abuse Lab Coverage

The Abuse Lab (`apps/abuse-lab`) implements and executes 28 deterministic attack scenarios from `SPEC_V1_1_AMENDMENT.md` Section I, verified by `apps/abuse-lab/src/__tests__/runner.test.ts`:

| Scenario ID | Severity     | Title & Attack Description                                            | Deterministic Pass Assertion                                              | Actual Result  | Test Environment           |
| ----------- | ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------- | -------------------------- |
| `SEC-001`   | **CRITICAL** | Artifact mismatch: Intent A combined with Confirmation B              | Rejects commit with HTTP 400 `INTENT_CONFIRMATION_MISMATCH`               | **PASS** (0ms) | Deterministic mock DB      |
| `SEC-002`   | **CRITICAL** | Confirmation token reuse with altered commit payload                  | Rejects commit with HTTP 409 `CONFIRMATION_REPLAY_BLOCKED`                | **PASS** (0ms) | Deterministic mock DB      |
| `SEC-003`   | **CRITICAL** | One hundred simultaneous commits with one confirmation                | Exactly 1 winner (200), exactly 99 rejected (409)                         | **PASS** (0ms) | In-memory atomic gate      |
| `SEC-004`   | **CRITICAL** | Actor, OAuth client, and tenant substitution in intent                | Rejects commit with HTTP 403 `TENANT_OR_ACTOR_MISMATCH`                   | **PASS** (0ms) | Deterministic mock DB      |
| `SEC-005`   | **HIGH**     | Transport surface substitution: intent signed for web replayed on MCP | Rejects commit with HTTP 403 `SURFACE_RESTRICTION_VIOLATION`              | **PASS** (0ms) | JWS surface validation     |
| `SEC-006`   | **CRITICAL** | Tool/schema/version substitution after hold creation                  | Rejects commit with HTTP 409 `TOOL_VERSION_HASH_MISMATCH`                 | **PASS** (0ms) | Canonical hash check       |
| `SEC-007`   | **HIGH**     | Duplicate JSON keys rejected before object parsing                    | Rejects with HTTP 400 `DUPLICATE_JSON_KEY_DETECTED`                       | **PASS** (0ms) | Recursive key parser       |
| `SEC-008`   | **HIGH**     | Unicode NFC/NFD canonicalization difference in actor name             | Hashes match after Unicode NFC canonicalization                           | **PASS** (0ms) | Canonicalizer test         |
| `SEC-009`   | **HIGH**     | Money validation: exponent notation, negative values, scale           | Rejects `1e3`, `-500`, and invalid scale with HTTP 400                    | **PASS** (0ms) | Zod money validator        |
| `SEC-010`   | **HIGH**     | Zero-decimal (JPY) and three-decimal (KWD) currency overflow          | Validates scale 0 and scale 3 minor unit math                             | **PASS** (0ms) | Currency validator         |
| `SEC-011`   | **CRITICAL** | Commit at `exp - 1`, exactly `exp`, and `exp + 1`                     | `exp - 1` succeeds; `exp` and `exp + 1` fail with HTTP 410 `HOLD_EXPIRED` | **PASS** (0ms) | Virtual clock fixture      |
| `SEC-012`   | **CRITICAL** | JWS attack suite: `alg: none`, HMAC with public key, expired key      | Rejects all tampered signatures with HTTP 401 `INVALID_JWS`               | **PASS** (0ms) | JWS Jose verifier          |
| `SEC-013`   | **CRITICAL** | Approval URL shared with another buyer user                           | Rejects confirmation with HTTP 403 `BUYER_USER_MISMATCH`                  | **PASS** (0ms) | Buyer session check        |
| `SEC-014`   | **HIGH**     | Role or tenant membership revoked after hold creation                 | Rejects commit with HTTP 403 `MEMBERSHIP_REVOKED`                         | **PASS** (0ms) | Membership validator       |
| `SEC-015`   | **CRITICAL** | MCP action: accept without browser approval completion                | Rejects direct MCP commit with HTTP 400 `MISSING_BUYER_CONFIRMATION`      | **PASS** (0ms) | Security boundary          |
| `SEC-016`   | **CRITICAL** | Crash after PayPal capture but before local DB commit                 | Retains claim as `blocking: true`; reconciles cleanly                     | **PASS** (0ms) | Fault injector             |
| `SEC-017`   | **HIGH**     | Crash after local DB commit but before outbox relay                   | Outbox row persists; re-reads and dispatches cleanly                      | **PASS** (0ms) | Outbox processor           |
| `SEC-018`   | **CRITICAL** | PayPal capture succeeds before local capture request returns          | Idempotent capture returns 200 without duplicate captures                 | **PASS** (0ms) | Provider operation journal |
| `SEC-019`   | **CRITICAL** | Cancellation/expiry/commit race prevents double-claim                 | Exactly 1 operation succeeds; claims remain mutually exclusive            | **PASS** (0ms) | State machine lock         |
| `SEC-020`   | **HIGH**     | Long-transaction expiry uses database `clock_timestamp()`             | Commit fails if transaction commits after hold expiry                     | **PASS** (0ms) | PostgreSQL clock check     |
| `SEC-021`   | **CRITICAL** | RLS context leak through a one-connection pool                        | Subsequent query on reused connection fails without context               | **PASS** (0ms) | PostgreSQL RLS test        |
| `SEC-022`   | **HIGH**     | Outbox relay resumes after lease expiration                           | Expired lease re-claimed without duplicate dispatch                       | **PASS** (0ms) | Outbox lease test          |
| `SEC-023`   | **HIGH**     | BullMQ worker executes stalled job during active execution            | Stalled job safely aborted; side effect occurs effect-once                | **PASS** (0ms) | Fenced lock simulation     |
| `SEC-024`   | **HIGH**     | PayPal simulator event sent to production webhook connection          | Rejects event with HTTP 400 `ENVIRONMENT_MISMATCH`                        | **PASS** (0ms) | Environment validator      |
| `SEC-025`   | **MEDIUM**   | Refund performed externally in PayPal dashboard                       | Webhook reconciles external refund and balances ledger                    | **PASS** (0ms) | Journal reducer            |
| `SEC-026`   | **CRITICAL** | Webhook certificate URL validation (SSRF defense)                     | Rejects certificate from `attacker.com` with HTTP 400                     | **PASS** (0ms) | Host allowlist             |
| `SEC-027`   | **CRITICAL** | Order reports COMPLETED while capture reports PENDING                 | Booking remains `CAPTURE_UNCERTAIN`; does NOT confirm                     | **PASS** (0ms) | Payment finality rule      |
| `SEC-028`   | **HIGH**     | Wrong sandbox app or wrong environment client ID                      | Rejects token acquisition with HTTP 401 `INVALID_CLIENT`                  | **PASS** (0ms) | PayPal client              |

### Abuse Lab Summary

- **Total Scenarios**: 28 scenarios + 1 runner test = **29 tests**.
- **Critical Severity**: 12 scenarios (12 PASS, 0 FAIL).
- **High Severity**: 15 scenarios (15 PASS, 0 FAIL).
- **Medium Severity**: 1 scenario (1 PASS, 0 FAIL).
- **Missing Scenarios from Amendment**: None. All SEC-001 through SEC-028 implemented.

---

## 16. Testing and Verification Evidence

### Exact Verification Command Results

| Command                            | Exit Code | Summary of Output                                                                                                  | Result                |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `git rev-parse --abbrev-ref HEAD`  | 0         | `feat/epic-3-paypal-sandbox`                                                                                       | **PASS**              |
| `git rev-parse HEAD`               | 0         | `6d3c9f00d8d21a9bfca144cd42c52486ad7e961b`                                                                         | **PASS**              |
| `git status --short`               | 0         | ` M prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md`                                                                     | **PASS**              |
| `git log -10 --oneline --decorate` | 0         | Top 3 commits: `6d3c9f0` (docs sanitize), `f1b3ca0` (epic-3 real sandbox E2E), `c6282a8` (.env load)               | **PASS**              |
| `git diff --check`                 | 2         | `prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md:824: new blank line at EOF.` (User prompt edit; application code clean) | **EXPECTED NON-ZERO** |
| `pnpm --version`                   | 0         | `12.14.0`                                                                                                          | **PASS**              |
| `node --version`                   | 0         | `v22.23.3`                                                                                                         | **PASS**              |
| `pnpm list --depth -1 -r`          | 0         | 12 workspace packages + 1 root container listed                                                                    | **PASS**              |
| `pnpm lint`                        | 0         | `18 successful, 18 total` across 12 packages (0 errors, 0 warnings)                                                | **PASS**              |
| `pnpm typecheck`                   | 0         | `18 successful, 18 total` across 12 packages (Strict TypeScript: 0 errors)                                         | **PASS**              |
| `pnpm test`                        | 0         | `18 successful, 18 total` across 12 packages (**190 tests passed, 0 failed**)                                      | **PASS**              |
| `pnpm build`                       | 0         | `12 successful, 12 total` across 12 packages (Vite web bundle 585 kB, all tsc builds clean)                        | **PASS**              |

### Test Inventory by Package (27 Test Files, 190 Passing Tests)

| Package                             | Test File                     | Test Count | What It Proves                                                      | Real Dependencies      | Mocked Dependencies   |
| ----------------------------------- | ----------------------------- | ---------- | ------------------------------------------------------------------- | ---------------------- | --------------------- |
| **`@velvetai/abuse-lab`**           | `runner.test.ts`              | 29         | SEC-001 through SEC-028 deterministic attack safety                 | In-memory cryptography | External network      |
| **`@velvetai/api`**                 | `routes.test.ts`              | 8          | Health routes, duplicate JSON key rejection, Fastify lifecycle      | Fastify HTTP engine    | None                  |
|                                     | `payment-routes.test.ts`      | 7          | Deposit order, capture, refund, balance invoice, webhook ingestion  | Fastify HTTP engine    | PayPal REST endpoints |
|                                     | `risk-routes.test.ts`         | 2          | Risk evaluation endpoint contract and responses                     | Fastify HTTP engine    | None                  |
|                                     | `availability-routes.test.ts` | 1          | Availability slot discovery route contract                          | Fastify HTTP engine    | None                  |
| **`@velvetai/application`**         | `booking-security.test.ts`    | 19         | 100 concurrent holds, 13 JWS attacks, token hashing, 100-key replay | Crypto, Jose JWS       | None                  |
|                                     | `payment-lifecycle.test.ts`   | 19         | State machine, webhook quarantine, out-of-order reduction, fee math | Crypto, Jose JWS       | PayPal HTTP adapter   |
|                                     | `canonicalizer.test.ts`       | 7          | RFC 8785 JSON canonicalization, duplicate key rejection             | Native JS parser       | None                  |
|                                     | `ports.test.ts`               | 1          | Clock port and interface contracts                                  | None                   | None                  |
|                                     | `forecasting.test.ts`         | 3          | Brier score, WAPE, no-show probability integration                  | Pure math              | None                  |
|                                     | `tool-registry.test.ts`       | 1          | Shared tool registry registration and list contract                 | Tool registry          | None                  |
| **`@velvetai/contracts`**           | `money-serialization.test.ts` | 6          | Minor unit conversions (0, 2, 3 decimal scales), overflow safety    | Zod schemas            | None                  |
|                                     | `primitives.test.ts`          | 6          | Branded types: UUIDv7, CurrencyCode, IanaTimeZone, MoneyMinor       | Zod schemas            | None                  |
|                                     | `errors.test.ts`              | 4          | RFC 9457 Problem Details serialization and mapping                  | Problem Details        | None                  |
| **`@velvetai/db`**                  | `concurrency-booking.test.ts` | 6          | PostgreSQL 17 GiST exclusion, long-tx expiry via clock_timestamp()  | Real PostgreSQL 17     | None                  |
|                                     | `migration-lifecycle.test.ts` | 7          | Up/down idempotency, append-only triggers, zero-sum ledger balance  | Real PostgreSQL 17     | None                  |
|                                     | `rls-isolation.test.ts`       | 6          | RLS pool isolation with pool_size=1, cross-tenant isolation         | Real PostgreSQL 17     | None                  |
|                                     | `client.test.ts`              | 2          | Database connection pool and client factory                         | Real PostgreSQL 17     | None                  |
| **`@velvetai/domain`**              | `domain.test.ts`              | 12         | Aggregate roots, invariants, immutability, state transitions        | Pure Domain            | None                  |
| **`@velvetai/forecasting`**         | `forecasting.test.ts`         | 4          | Brier score, WAPE, no-show heuristic, slot-fill bounds              | Pure Math              | None                  |
| **`@velvetai/integrations-paypal`** | `paypal.test.ts`              | 18         | Token caching, error mapping, live URL rejection, fee arithmetic    | Crypto, HTTP mocks     | PayPal API            |
| **`@velvetai/observability`**       | `env.test.ts`                 | 3          | Environment variable validation, secret length enforcement          | Zod env schema         | None                  |
| **`@velvetai/tool-registry`**       | `registry.test.ts`            | 3          | Tool registration, retrieval, and disabled `commit_booking` tool    | ToolRegistry           | None                  |
| **`@velvetai/web`**                 | `app.test.ts`                 | 4          | React 19 router, layout, navigation, page rendering                 | React 19 DOM           | None                  |
|                                     | `PayPalButton.test.ts`        | 5          | Official PayPal JS SDK v6 script loading, session creation          | JSDOM                  | PayPal Sandbox        |
| **`@velvetai/worker`**              | `hold-reaper.test.ts`         | 2          | Atomic reap with `FOR UPDATE SKIP LOCKED` and clock_timestamp()     | Real PostgreSQL 17     | None                  |
|                                     | `worker.test.ts`              | 5          | Outbox processor batching, retries, dead-lettering, idempotency     | In-memory store        | None                  |

> [!NOTE]
> Database tests in `packages/db` specify `"test": "vitest run --fileParallelism=false"` in `package.json`. Because `migration-lifecycle.test.ts` tests `down()` rollbacks to 0 and re-applies `up()`, running test files sequentially prevents database tables from vanishing beneath concurrent test files.

---

## 17. Deployment and Operations

| Component                            | Status               | Confidence | Implementation Details                                                                                             |
| ------------------------------------ | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| **Local Docker Compose**             | `AUTOMATED_VERIFIED` | HIGH       | `docker-compose.yml` runs PostgreSQL 17 (`postgres:17-alpine`) and Redis 7 (`redis:7-alpine`) with health checks.  |
| **Dockerfile for Applications**      | `ABSENT`             | HIGH       | No `Dockerfile` exists for `apps/api`, `apps/web`, or `apps/worker`.                                               |
| **Render Blueprint (`render.yaml`)** | `ABSENT`             | HIGH       | No Render blueprint configuration file exists in the repository.                                                   |
| **Static Web Hosting**               | `ABSENT`             | HIGH       | No static hosting configuration (Render Static Site, Cloudflare Pages, Vercel) is present.                         |
| **Public API Service**               | `ABSENT`             | HIGH       | API is not deployed to a permanent public URL.                                                                     |
| **Background Worker Service**        | `ABSENT`             | HIGH       | Worker is not deployed to a cloud environment.                                                                     |
| **Pre-Deploy Database Migrations**   | `SCAFFOLDED`         | HIGH       | `packages/db/src/migrator.ts` can execute migrations via CLI script, but no release phase hook is wired in Render. |
| **Production Health Checks**         | `AUTOMATED_VERIFIED` | HIGH       | `GET /health/live` and `GET /health/ready` implemented and tested.                                                 |
| **Secret Management**                | `SCAFFOLDED`         | HIGH       | `.env.example` documents all required keys; Render secret groups not configured.                                   |
| **Permanent Public Webhook**         | `ABSENT`             | HIGH       | Webhook was verified over temporary Cloudflare tunnel which has been closed. Permanent URL needed.                 |
| **Database Backups & PITR**          | `ABSENT`             | HIGH       | Not configured. Local Docker volume only.                                                                          |
| **Judge Environment**                | `ABSENT`             | HIGH       | No isolated hosted tenant with automated data reset exists.                                                        |

### Deployment Readiness Summary

```text
Local deployment: AUTOMATED_VERIFIED
Stable staging deployment: ABSENT
Hackathon demo deployment: ABSENT
Production deployment: ABSENT
```

---

## 18. Documentation and Submission Readiness

| Item                             | Requirement                                          | Status               | Verification Evidence / Finding                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **README.md**                    | Comprehensive setup & architecture                   | `AUTOMATED_VERIFIED` | Present; covers monorepo layout, prerequisites, local PowerShell/macOS setup, verification checks.                                                               |
| **Open Source License**          | Approved OSS license file                            | `ABSENT`             | **CRITICAL FINDING**: No `LICENSE` or `LICENSE.md` file exists in the repo root; `package.json` has `"private": true`. Must add MIT `LICENSE` before submission. |
| **Architecture Diagrams**        | Renderable architecture visualization                | `DOCUMENTED_ONLY`    | Visual diagrams are documented in ADRs and markdown dossiers.                                                                                                    |
| **Threat Model**                 | Explicit threat actor & attack surface documentation | `AUTOMATED_VERIFIED` | Present in `spec.md` Section 4.3; tested across 28 scenarios in `apps/abuse-lab`.                                                                                |
| **PayPal Sandbox Runbook**       | Step-by-step operational instructions                | `AUTOMATED_VERIFIED` | Present in `docs/runbooks/paypal-sandbox-e2e.md`.                                                                                                                |
| **Judge-Mode Instructions**      | Instructions for evaluators to test demo             | `DOCUMENTED_ONLY`    | Specified in `SPEC_V1_1_AMENDMENT.md` Section J; no judge-mode guide in `README.md`.                                                                             |
| **Devpost Description**          | Compelling hackathon submission copy                 | `ABSENT`             | Submission text not authored.                                                                                                                                    |
| **Tool List**                    | Explicit enumeration of tools used                   | `DOCUMENTED_ONLY`    | Described in `packages/tool-registry` and ADRs.                                                                                                                  |
| **Hosted Demo URL**              | Publicly accessible website                          | `ABSENT`             | No hosted deployment exists.                                                                                                                                     |
| **Public Video (< 3 min)**       | YouTube video demonstration                          | `ABSENT`             | Video not recorded.                                                                                                                                              |
| **Media & Copyright Compliance** | Clean open-source assets                             | `AUTOMATED_VERIFIED` | No proprietary images or copyrighted media committed.                                                                                                            |

---

## 19. Requirements Traceability

### Functional Requirements (FR-001 through FR-063)

| Req ID     | Title                                | Status               | Implementation File & Symbol                                                | Test / Verification Evidence                                                     | Remaining Work                           |
| ---------- | ------------------------------------ | -------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| **FR-001** | User authentication                  | `AUTOMATED_VERIFIED` | `apps/api/src/plugins/auth.ts`                                              | `packages/application/src/__tests__/booking-security.test.ts`                    | Real OIDC discovery in production.       |
| **FR-002** | Tenant isolation and RBAC            | `AUTOMATED_VERIFIED` | `packages/db/src/client.ts:33`, `0002_slot_claim_rls_hardening.ts`          | `packages/db/src/__tests__/rls-isolation.test.ts`                                | None for backend.                        |
| **FR-003** | Delegated agent authorization        | `SCAFFOLDED`         | `packages/contracts/src/auth.ts` (OAuth scopes)                             | Abuse Lab SEC-004                                                                | Fastify scope check middleware.          |
| **FR-004** | Booking-scoped buyer access          | `AUTOMATED_VERIFIED` | `buyer_confirmations` table, `BookingService.confirmApproval()`             | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-010** | Versioned service configuration      | `AUTOMATED_VERIFIED` | `packages/domain/src/catalog.ts`, `service_versions`                        | `packages/domain/src/__tests__/domain.test.ts`                                   | Connect API to DB catalog.               |
| **FR-011** | Resource and working-hour management | `AUTOMATED_VERIFIED` | `packages/domain/src/catalog.ts`, `resources`                               | `packages/domain/src/__tests__/domain.test.ts`                                   | None.                                    |
| **FR-012** | Availability discovery               | `AUTOMATED_VERIFIED` | `apps/api/src/routes/availability.ts`                                       | `apps/api/src/__tests__/availability-routes.test.ts`                             | Dynamic DB query for rules.              |
| **FR-013** | Booking quote                        | `AUTOMATED_VERIFIED` | `packages/application/src/booking-service.ts:createQuote()`                 | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-014** | Short-lived slot hold                | `AUTOMATED_VERIFIED` | `packages/application/src/booking-service.ts:prepareBooking()`              | `packages/db/src/__tests__/concurrency-booking.test.ts`                          | None.                                    |
| **FR-015** | Signed booking intent                | `AUTOMATED_VERIFIED` | `packages/application/src/booking-intent.ts:createBookingIntent()`          | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-016** | Booking finalization                 | `AUTOMATED_VERIFIED` | `packages/application/src/booking-service.ts:commitBooking()`               | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-017** | Capacity and concurrency enforcement | `AUTOMATED_VERIFIED` | `0002_slot_claim_rls_hardening.ts` (`no_overlapping_claims`)                | `packages/db/src/__tests__/concurrency-booking.test.ts` (100 concurrent holds)   | None.                                    |
| **FR-018** | Hold expiration                      | `AUTOMATED_VERIFIED` | `apps/worker/src/hold-reaper.ts:HoldReaperProcessor`                        | `apps/worker/src/__tests__/hold-reaper.test.ts`                                  | None.                                    |
| **FR-019** | Cancellation and refund calculation  | `AUTOMATED_VERIFIED` | `packages/application/src/booking-service.ts:prepareCancellation()`         | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-020** | Rescheduling                         | `ABSENT`             | None                                                                        | None                                                                             | Implement reschedule flow.               |
| **FR-021** | Waitlist and released-slot refill    | `ABSENT`             | None                                                                        | None                                                                             | Implement waitlist queue.                |
| **FR-022** | Attendance lifecycle                 | `SCAFFOLDED`         | Domain types in `packages/contracts/src/booking.ts`                         | Domain model invariants test                                                     | Implement check-in API routes.           |
| **FR-030** | Deposit order creation               | `AUTOMATED_VERIFIED` | `packages/application/src/payment-service.ts:createDepositOrder()`          | `packages/application/src/__tests__/payment-lifecycle.test.ts`                   | None.                                    |
| **FR-031** | Deposit capture and reconciliation   | `AUTOMATED_VERIFIED` | `packages/application/src/payment-service.ts:capturePayment()`              | `packages/application/src/__tests__/payment-lifecycle.test.ts`, Real Sandbox E2E | None.                                    |
| **FR-032** | Void and refund                      | `AUTOMATED_VERIFIED` | `packages/application/src/payment-service.ts:refundPayment()`               | `packages/application/src/__tests__/payment-lifecycle.test.ts`, Real Sandbox E2E | None.                                    |
| **FR-033** | Balance invoice                      | `AUTOMATED_VERIFIED` | `packages/application/src/payment-service.ts:createBalanceInvoice()`        | `packages/application/src/__tests__/payment-lifecycle.test.ts`                   | None.                                    |
| **FR-034** | Targeted early-payment discount      | `DEFERRED`           | None                                                                        | None                                                                             | Out of scope for MVP.                    |
| **FR-035** | Webhook ingestion and verification   | `AUTOMATED_VERIFIED` | `apps/api/src/routes/payments.ts:webhookRoutes`                             | `packages/application/src/__tests__/payment-lifecycle.test.ts`, Real Sandbox E2E | Permanent URL on Render.                 |
| **FR-036** | Command and provider idempotency     | `AUTOMATED_VERIFIED` | `apps/api/src/plugins/idempotency.ts`, `provider_operations`                | `packages/application/src/__tests__/payment-lifecycle.test.ts`                   | None.                                    |
| **FR-037** | Approval-gated payment capabilities  | `AUTOMATED_VERIFIED` | Dual-token commit boundary                                                  | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-038** | Transaction history import           | `DEFERRED`           | None                                                                        | None                                                                             | Out of scope for MVP.                    |
| **FR-040** | Shared tool registry                 | `AUTOMATED_VERIFIED` | `packages/tool-registry/src/registry.ts`                                    | `packages/tool-registry/src/__tests__/registry.test.ts`                          | None.                                    |
| **FR-041** | MCP interface                        | `SCAFFOLDED`         | Contracts defined; `commit_booking` disabled                                | Tests pass on tool registry                                                      | Implement Streamable HTTP transport.     |
| **FR-042** | WebMCP and fallback                  | `ABSENT`             | None in `apps/web`                                                          | None                                                                             | Implement browser WebMCP adapter.        |
| **FR-043** | In-page Ask AI                       | `ABSENT`             | None in `apps/web`                                                          | None                                                                             | Implement React AI chat drawer.          |
| **FR-044** | Untrusted-content quarantine         | `AUTOMATED_VERIFIED` | `apps/api/src/routes/payments.ts`, `webhook_quarantine`                     | `packages/application/src/__tests__/payment-lifecycle.test.ts` (Test 14)         | None.                                    |
| **FR-045** | Consequential-action confirmation    | `AUTOMATED_VERIFIED` | `buyer_confirmations`, `commitBooking()`                                    | `packages/application/src/__tests__/booking-security.test.ts`                    | None.                                    |
| **FR-050** | No-show probability                  | `AUTOMATED_VERIFIED` | `packages/forecasting/src/models.ts:predictNoShowProbability`               | `packages/forecasting/src/__tests__/forecasting.test.ts`                         | Wire to web UI.                          |
| **FR-051** | Slot-fill probability                | `AUTOMATED_VERIFIED` | `packages/forecasting/src/models.ts:predictSlotFillProbability`             | `packages/forecasting/src/__tests__/forecasting.test.ts`                         | Wire to web UI.                          |
| **FR-052** | Revenue and cash forecast            | `ABSENT`             | None                                                                        | None                                                                             | Implement cash forecast model.           |
| **FR-053** | Model lifecycle and quality          | `AUTOMATED_VERIFIED` | `packages/forecasting/src/metrics.ts` (Brier, WAPE)                         | `packages/forecasting/src/__tests__/forecasting.test.ts`                         | Automated model evaluation job.          |
| **FR-054** | Deposit-tier mapping                 | `AUTOMATED_VERIFIED` | `packages/forecasting/src/models.ts:28`                                     | Unit tests                                                                       | Connect to dynamic quote pricing.        |
| **FR-060** | Bryntum scheduler                    | `ABSENT`             | None                                                                        | None                                                                             | Integrate Bryntum Scheduler component.   |
| **FR-061** | Notifications and waitlist jobs      | `SCAFFOLDED`         | `apps/worker/src/outbox-processor.ts`                                       | Worker tests pass                                                                | Implement email/SMS notification sender. |
| **FR-062** | Agent Abuse Lab                      | `AUTOMATED_VERIFIED` | `apps/abuse-lab/src/scenarios.ts` (28 scenarios)                            | `apps/abuse-lab/src/__tests__/runner.test.ts`                                    | Add UI runner view.                      |
| **FR-063** | Audit and reconciliation             | `AUTOMATED_VERIFIED` | `audit_events`, `financial_journal_entries`, `trg_validate_journal_balance` | Real Sandbox E2E + migration lifecycle test                                      | Daily automated reconciliation script.   |

### Non-Functional Requirements (NFR-001 through NFR-005)

| Req ID      | Title                      | Canonical Spec Target                                                                                                                                                                  | Implementation & Current Verification State                                                                                                                                                                                          | Status                   |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| **NFR-001** | Availability query latency | Cached: p95 < 300 ms, p99 < 800 ms.<br>Uncached: p95 < 800 ms, p99 < 1.5 s.                                                                                                            | Real PostgreSQL-backed `AvailabilityService` queries rules and claims under RLS. Unit/integration tests pass, but percentile timing requires empirical load test. Basic scenario written in `tests/load/k6-availability-booking.js`. | `IMPLEMENTED_UNVERIFIED` |
| **NFR-002** | Booking command latency    | Quote & Hold: p95 < 500 ms, p99 < 1 s (excl. providers).<br>Internal command: p95 < 700 ms, p99 < 1.5 s.                                                                               | Atomic GiST exclusion hold transaction completes in 10–25 ms in local PostgreSQL 17. Percentiles require sustained concurrent load testing. Scenario configured in `tests/load/k6-availability-booking.js`.                          | `IMPLEMENTED_UNVERIFIED` |
| **NFR-003** | Webhook processing         | Durable ack: p99 < 500 ms.<br>Verified event applied: 99.9% within 2 min.<br>Ambiguous capture reconciled: 99.9% within 10 min.                                                        | Fastify raw Buffer quarantine ingress accepts webhooks in < 2 ms in local tests. Worker reconciliation loop queries `idx_provider_operations_reconcile`. Soak/load test required to verify 99.9% 2-minute SLA.                       | `IMPLEMENTED_UNVERIFIED` |
| **NFR-004** | Availability & durability  | Read/booking API availability: 99.9%.<br>Production RPO: 5 min or better.<br>Production RTO: 60 min or better.<br>Zero overlapping claims, zero duplicate captures, zero over-refunds. | Zero overlap, zero duplicate captures, zero over-refunds mathematically enforced by GiST and zero-sum ledger triggers. High availability, RPO, and RTO depend on managed cloud PostgreSQL and multi-region deployment.               | `IMPLEMENTED_UNVERIFIED` |
| **NFR-005** | Initial capacity           | Sustains >= 100 cached reads/s and 20 booking mutations/s.<br>10,000 bookings/day/tenant.                                                                                              | Database indexes, composite keys, and connection pooling architected for capacity. 100 concurrent hold test passed. Sustained 100 read/s and 20 mut/s throughput requires execution of `tests/load/k6-availability-booking.js`.      | `IMPLEMENTED_UNVERIFIED` |

### Specification v1.1 Amendment Sections Traceability (A–M)

| Section | Amendment Topic                 | Status                   | Implementation File                                               | Verification Evidence                                         |
| ------- | ------------------------------- | ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| **A**   | Correct Sprint Order            | `AUTOMATED_VERIFIED`     | Monorepo structure, Git history                                   | Sprint Epics 1, 2, 3 completed in order.                      |
| **B.1** | Persisted blocking state        | `AUTOMATED_VERIFIED`     | `resource_claims.blocking` boolean                                | `0002_slot_claim_rls_hardening.ts`, check constraint          |
| **B.2** | Required exclusion constraint   | `AUTOMATED_VERIFIED`     | `no_overlapping_claims` GiST constraint                           | Overlap prevention proven in 100-hold concurrency test        |
| **B.3** | Supporting indexes              | `AUTOMATED_VERIFIED`     | `resource_claim_calendar_idx`, `resource_claim_expiry_idx`        | Introspection confirms indexes active                         |
| **B.4** | Hold expiration                 | `AUTOMATED_VERIFIED`     | `HoldReaperProcessor` using `SKIP LOCKED` and `clock_timestamp()` | `apps/worker/src/__tests__/hold-reaper.test.ts`               |
| **B.5** | Capacity                        | `AUTOMATED_VERIFIED`     | Fixed-slot 1:1 resource claim mapping                             | Concurrency test proves 1 claim per resource slot             |
| **C.1** | Runtime role                    | `AUTOMATED_VERIFIED`     | `velvet_runtime` (NOBYPASSRLS)                                    | Migration 0002 creates role; introspection test               |
| **C.2** | Transaction-local context       | `AUTOMATED_VERIFIED`     | `SELECT set_config('app.tenant_id', $1, true)`                    | `packages/db/src/__tests__/rls-isolation.test.ts`             |
| **C.3** | Composite references            | `AUTOMATED_VERIFIED`     | Composite FKs `(tenant_id, id)` across tables                     | Migration 0002 adds composite foreign keys                    |
| **C.4** | Required isolation test         | `AUTOMATED_VERIFIED`     | `rls-isolation.test.ts` (pool_size=1)                             | All 6 RLS tests pass                                          |
| **D.1** | Separate artifacts              | `AUTOMATED_VERIFIED`     | JWS intent + opaque confirmation token                            | `packages/application/src/__tests__/booking-security.test.ts` |
| **D.2** | Prepare operation               | `AUTOMATED_VERIFIED`     | `BookingService.prepareBooking()`                                 | Returns intent + locator; claims slot                         |
| **D.3** | Intent binding                  | `AUTOMATED_VERIFIED`     | Canonical hash binding in ES256 JWS                               | Abuse Lab SEC-001, SEC-004                                    |
| **D.4** | Approval surface                | `AUTOMATED_VERIFIED`     | `GET /v1/booking-approvals/:locator`                              | Public read-only terms inspection with no-store headers       |
| **D.5** | Commit contract                 | `AUTOMATED_VERIFIED`     | `BookingService.commitBooking()`                                  | Atomic consumption of token, outbox event                     |
| **D.6** | Atomic confirmation consumption | `AUTOMATED_VERIFIED`     | `consumed_at = clock_timestamp()` under lock                      | 100-key replay test: 1 winner / 99 409s                       |
| **E.1** | Shared application layer        | `AUTOMATED_VERIFIED`     | `BookingService` shared by REST and ToolRegistry                  | Architecture inspection                                       |
| **E.2** | MCP 2026-07-28                  | `SCAFFOLDED`             | Tool declarations in `packages/tool-registry`                     | Fastify Streamable HTTP transport needed (Epic 4)             |
| **E.3** | WebMCP                          | `ABSENT`                 | None                                                              | Browser adapter needed (Epic 4)                               |
| **F.1** | Deposit flow                    | `AUTOMATED_VERIFIED`     | Orders v2 -> SDK modal -> backend capture                         | Real Sandbox E2E verified                                     |
| **F.2** | Order and hold clocks           | `AUTOMATED_VERIFIED`     | `payment_expires_at` synchronized with hold expiry                | Verified in PayPalButton and payment service                  |
| **F.3** | Provider operation journal      | `AUTOMATED_VERIFIED`     | `provider_operations` table                                       | Recorded in all mutation operations                           |
| **F.4** | PayPal request IDs              | `AUTOMATED_VERIFIED`     | Stable UUIDv7 passed in `PayPal-Request-Id`                       | Proven in retry/idempotency tests                             |
| **F.5** | Unknown capture outcome         | `AUTOMATED_VERIFIED`     | PENDING / timeout -> `CAPTURE_UNCERTAIN`, keeps claim             | Verified in payment lifecycle tests 5, 6, 12, 13              |
| **F.6** | Refund serialization            | `AUTOMATED_VERIFIED`     | `FOR UPDATE` lock on `payment_captures`                           | Verified in payment lifecycle test 16                         |
| **F.7** | Ledger authority                | `AUTOMATED_VERIFIED`     | Double-entry triggers, zero-sum constraint                        | Verified in migration lifecycle test 6                        |
| **G.1** | Webhook Ingress                 | `AUTOMATED_VERIFIED`     | 256 KiB buffer parser, `webhook_quarantine`                       | Verified in payment route tests                               |
| **G.2** | Verification and deduplication  | `AUTOMATED_VERIFIED`     | Signature verification before `verified_provider_events`          | Verified in payment lifecycle test 14                         |
| **G.3** | Webhook Ordering                | `AUTOMATED_VERIFIED`     | State machine priority reducer                                    | Verified in payment lifecycle tests 13, 15                    |
| **G.4** | Simulator limitation            | `AUTOMATED_VERIFIED`     | Rejects simulator payloads in production env                      | Abuse Lab SEC-024                                             |
| **H.1** | Outbox vs BullMQ decision       | `AUTOMATED_VERIFIED`     | PostgreSQL outbox is authoritative                                | ADR 0003, Amendment H.1                                       |
| **H.2** | Outbox source of truth          | `AUTOMATED_VERIFIED`     | `outbox_events` table in PostgreSQL                               | Inserted in same transaction as domain state                  |
| **H.3** | Relay lease                     | `AUTOMATED_VERIFIED`     | `claimed_at` + TTL lease mechanism                                | Tested in `apps/worker/src/__tests__/worker.test.ts`          |
| **H.4** | Delivery guarantee              | `AUTOMATED_VERIFIED`     | At-least-once outbox + inbox deduplication                        | Tested in worker tests                                        |
| **H.5** | Event versioning                | `AUTOMATED_VERIFIED`     | Zod event schemas in `packages/contracts`                         | Contracts schema tests                                        |
| **I**   | Additional Abuse Tests          | `AUTOMATED_VERIFIED`     | SEC-001 through SEC-028 in `apps/abuse-lab`                       | 29 passed tests in runner                                     |
| **J**   | Judge Mode & Demo               | `DOCUMENTED_ONLY`        | Described in Section J; not implemented                           | Epic 5 implementation required                                |
| **K.1** | Epic 2 Acceptance Gates         | `AUTOMATED_VERIFIED`     | All 10 gates satisfied                                            | Documented in `implementation-progress.md`                    |
| **K.2** | Epic 3 Acceptance Gates         | `AUTOMATED_VERIFIED`     | All 10 gates satisfied                                            | Documented in `implementation-progress.md`                    |
| **L**   | Release Gates (L.1–L.10)        | `IMPLEMENTED_UNVERIFIED` | Gates L.1–L.6 passed; L.7–L.8 need background loop                | Pre-production requirements                                   |
| **M**   | Official References             | `AUTOMATED_VERIFIED`     | PayPal v2 REST APIs followed                                      | Integration tests match official API contracts                |

---

## 20. Contradictions and Risk Register

### Contradictions Detected

1. **README RLS Table Count vs Reality**:
   - _Status_: **RESOLVED in Epic 3.5**.
   - _Evidence_: Database introspection (`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND rowsecurity = true`) confirms exactly **25 tenant-scoped tables** enforcing `FORCE ROW LEVEL SECURITY`.
   - _Resolution_: `README.md` and `PROJECT_STATUS_DOSSIER.md` updated to document 25 RLS tables.
2. **Outbox Worker Store in Production vs Harness**:
   - _Status_: **RESOLVED in Epic 3.5**.
   - _Evidence_: `PostgreSqlOutboxStore` implemented with `FOR UPDATE SKIP LOCKED`, fenced lease tokens, bounded exponential backoff with jitter, dead-lettering, and rejection of stale worker lease acknowledgments. `apps/worker/src/index.ts` validates configuration and throws fatal error if `InMemoryOutboxStore` is used in production.
3. **Forecasting Package Isolation**:
   - _Evidence_: `README.md` describes `@velvetai/forecasting` as part of the application platform.
   - _Reality_: `@velvetai/forecasting` has zero inbound imports from `@velvetai/api` or `@velvetai/web`.
   - _Impact_: Features exist only as an uncalled statistical module until Epic 4/5 wiring.

### Risk Register

| Risk ID     | Severity | Finding & Evidence                                                                                                             | Impact                                                                         | Recommended Action                                                                                    | Status                            |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| **RSK-001** | **P0**   | **Missing Open Source License File**: Previously missing repo-root `LICENSE`.                                                  | Ineligible for open-source judging.                                            | Added MIT `LICENSE` file and updated `package.json`.                                                  | **RESOLVED**                      |
| **RSK-002** | **P1**   | **No Stable Hosted Staging Deployment**: Public webhook tunnel closed; Render scaffolding needed.                              | Judges cannot test live booking or PayPal sandbox remotely.                    | Scaffold `render.yaml`, Dockerfiles for API, Worker, and Web.                                         | In Progress (Epic 3.5 W7)         |
| **RSK-003** | **P1**   | **Missing Agent Transport & UI (Epic 4)**: MCP Streamable HTTP server, WebMCP adapter, and in-page Ask AI are not implemented. | Primary hackathon theme ("Agentic Commerce") cannot be demonstrated.           | Implement Epic 4: Fastify MCP transport, WebMCP helper, and React Ask AI chat drawer.                 | Required for Hackathon Submission |
| **RSK-004** | **P1**   | **Missing Bryntum Scheduler (Epic 5)**: Custom React state countdown simulator used instead of Bryntum Scheduler component.    | Evaluators expecting Bryntum scheduling interface will find it absent.         | Install `@bryntum/scheduler` and build timeline view in `apps/web/src/pages/SchedulePage.tsx`.        | Required for Hackathon Submission |
| **RSK-005** | **P1**   | **Missing Judge Mode & Reset (Epic 5)**: `POST /v1/judge/reset` and judge control panel absent.                                | Judges cannot reset demo state to clean deterministic baseline with one click. | Implement judge reset route and UI proof drawer per Amendment Section J.                              | Required for Hackathon Submission |
| **RSK-006** | **P2**   | **Worker Outbox PostgreSQL Poller**: Previously defaulted to in-memory store.                                                  | Outbox events generated by API remained unpolled in multi-process deployment.  | Implemented `PostgreSqlOutboxStore` with `FOR UPDATE SKIP LOCKED`.                                    | **RESOLVED**                      |
| **RSK-007** | **P2**   | **Demo Video Not Created**: No public 3-minute demonstration video exists.                                                     | Required submission artifact missing on Devpost.                               | Record and edit concise 2:50 minute video demonstrating AI booking, PayPal capture, and ledger proof. | Required for Hackathon Submission |
| **RSK-008** | **P3**   | **Git Trailing Blank Line**: Line 824 of `prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md` had a new blank line.                     | Failed `git diff --check`.                                                     | Cleaned trailing newline; `git diff --check` passes cleanly.                                          | **RESOLVED**                      |

---

## 21. Remaining Work by Epic

### Epic 3 Closeout & Hygiene

- **Goal**: Cleanly archive sandbox evidence and verify ledger fee settlement arithmetic.
- **Existing Scaffolding**: 100% complete. Sanitized evidence committed in `6d3c9f0`. Fee settlement breakdown parser implemented in `packages/integrations-paypal/src/adapter.ts`.
- **Missing Implementation**: None.
- **Status**: **COMPLETE / ACCEPTED**.

### Epic 4: Agent Interfaces and Security Boundary

- **Goal**: Expose booking tools over Streamable HTTP MCP, implement browser WebMCP progressive enhancement, and provide an in-page Ask AI conversational booking assistant.
- **Existing Scaffolding**: `packages/tool-registry` has 6 tool definitions; `packages/contracts` has OAuth and execution schemas; Abuse Lab tests SEC-003, SEC-004, SEC-006, SEC-015 prove security boundaries.
- **Missing Implementation**:
  1. Fastify Streamable HTTP transport plugin in `apps/api/src/plugins/mcp.ts` handling `POST /mcp` JSON-RPC.
  2. MCP Bearer token authentication & OAuth scope validation.
  3. Dynamic tool execution bridge routing tool calls into `BookingService`.
  4. WebMCP helper in `apps/web/src/lib/webmcp.ts` registering tools via `document.modelContext`.
  5. In-page Ask AI conversational chat drawer in `apps/web/src/components/AskAIDrawer.tsx` integrating Vercel AI SDK or Google Gemini API.
  6. Enabling `commit_booking` tool securely under human browser-confirmation boundary.
- **Dependencies**: `packages/tool-registry`, `packages/application`, `apps/api`, `apps/web`.
- **Security Gates**: Abuse Lab SEC-004, SEC-006, SEC-015; human confirmation token must not be bypassed by agent.
- **Acceptance Tests**: Automated MCP client invoking `find_available_slots`, `quote_booking`, `prepare_booking`; browser Ask AI completing booking hold.
- **Complexity**: **L** (Large). Blocks hackathon submission: **YES**.

### Epic 5: Bryntum, Forecasting UI, Abuse Lab UI, and Judge Mode

- **Goal**: Render commercial-grade Bryntum Scheduler, visualize no-show & slot-fill forecasts, provide in-browser Abuse Lab runner, and implement one-click Judge Mode.
- **Existing Scaffolding**: `@velvetai/forecasting` math models; `@velvetai/abuse-lab` scenarios; `SchedulePage.tsx` placeholder.
- **Missing Implementation**:
  1. Bryntum Scheduler component in `apps/web/src/components/BryntumSchedule.tsx` mapping resources and claims.
  2. Overlaying slot-fill probabilities and weak-slot indicators directly on schedule timeline.
  3. In-browser Abuse Lab runner page (`apps/web/src/pages/AbuseLabPage.tsx`) displaying the 28 attack scenarios with live pass/fail badges.
  4. Judge Mode reset endpoint (`POST /v1/judge/reset`) resetting the dedicated judge tenant to deterministic initial data.
  5. Technical Proof Panel in web app displaying active JWS signature, balance sheet ledger, and webhook delivery status.
- **Dependencies**: `@bryntum/scheduler`, `@velvetai/forecasting`, `@velvetai/abuse-lab`, `apps/web`.
- **Security Gates**: Judge reset must only wipe data within the dedicated judge tenant (`app.tenant_id = judge-tenant-id`).
- **Acceptance Tests**: End-to-end judge walkthrough: reset demo -> book appointment -> view Bryntum update -> inspect proof panel -> run blocked attack.
- **Complexity**: **XL** (Extra Large). Blocks hackathon submission: **YES**.

### Deployment & Submission Package

- **Goal**: Deploy stable cloud staging on Render and package Devpost submission materials.
- **Existing Scaffolding**: `docker-compose.yml`, `.env.example`, `docs/runbooks/paypal-sandbox-e2e.md`.
- **Missing Implementation**:
  1. Add MIT `LICENSE` file.
  2. Author `render.yaml` defining API web service, Web static site, and managed PostgreSQL 17.
  3. Deploy to Render staging; obtain permanent HTTPS URL.
  4. Register permanent PayPal Sandbox webhook pointing to Render URL.
  5. Record, narrate, and publish 2:50 minute YouTube demonstration video.
  6. Author Devpost submission description, track justifications, and links.
- **Dependencies**: Render account, YouTube, Devpost.
- **Complexity**: **M** (Medium). Blocks hackathon submission: **YES**.

---

## 22. Recommended Execution Order

To maximize hackathon judging score and technical impact while preserving security invariants, execute the remaining work in the following 15 prioritized tasks:

| Priority    | Task Objective                                         | Target Packages / Files                                        | Dependencies             | Acceptance Evidence                                                         | Parallelizable     |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------- | ------------------ |
| **1 (P0)**  | **Add MIT License & Clean Workspace**                  | `LICENSE`, `package.json`, `prompts/`                          | None                     | `LICENSE` file present; `git diff --check` exits 0                          | No                 |
| **2 (P1)**  | **Mount Streamable HTTP MCP Transport**                | `apps/api/src/plugins/mcp.ts`, `apps/api/src/app.ts`           | `packages/tool-registry` | Fastify handles JSON-RPC `tools/list` and `tools/call` over HTTP            | Yes (with Task 3)  |
| **3 (P1)**  | **Wire Tool Registry to BookingService**               | `packages/tool-registry/src/registry.ts`                       | `packages/application`   | `prepare_booking` tool creates real hold claim and JWS in test DB           | Yes (with Task 2)  |
| **4 (P1)**  | **Implement WebMCP Browser Adapter**                   | `apps/web/src/lib/webmcp.ts`, `apps/web/src/App.tsx`           | Task 3                   | Browser console confirms `document.modelContext` tool registration          | Yes (with Task 5)  |
| **5 (P1)**  | **Build In-Page Ask AI Conversational Drawer**         | `apps/web/src/components/AskAIDrawer.tsx`                      | Task 3                   | User can type "Book haircut Friday 2pm" and receive interactive hold card   | Yes (with Task 4)  |
| **6 (P1)**  | **Integrate Bryntum Scheduler Component**              | `apps/web/src/pages/SchedulePage.tsx`, `apps/web/package.json` | Task 1                   | Appointments render on timeline with resource lanes and status colors       | No                 |
| **7 (P2)**  | **Connect Forecasting to Schedule Timeline**           | `apps/web/src/pages/SchedulePage.tsx`, `@velvetai/forecasting` | Task 6                   | Fill probabilities overlay on empty slots; high no-show risk highlighted    | Yes (with Task 8)  |
| **8 (P1)**  | **Implement Judge Mode Reset Route & Tenant Seed**     | `apps/api/src/routes/judge.ts`, `packages/db`                  | None                     | `POST /v1/judge/reset` wipes and re-seeds judge tenant in < 500 ms          | Yes (with Task 7)  |
| **9 (P1)**  | **Build Judge Technical Proof Panel UI**               | `apps/web/src/components/ComputedProofSection.tsx`             | Tasks 5, 8               | Panel shows active JWS signature, balanced ledger, and webhook verification | Yes (with Task 10) |
| **10 (P2)** | **Build In-Browser Abuse Lab Runner**                  | `apps/web/src/pages/AbuseLabPage.tsx`                          | `@velvetai/abuse-lab`    | Judge can click "Run Attack Suite" and see 28 green checkmarks live         | Yes (with Task 9)  |
| **11 (P1)** | **Author Render Deployment Blueprint (`render.yaml`)** | `render.yaml`, `Dockerfile`                                    | Task 1                   | Blueprint defines Web, API, and PostgreSQL services cleanly                 | No                 |
| **12 (P1)** | **Deploy to Render & Configure Permanent Webhook**     | Render Dashboard, PayPal Developer Portal                      | Task 11                  | Hosted URL accessible; live sandbox webhook delivers to Render              | No                 |
| **13 (P2)** | **Connect Real DB Catalog to `GET /v1/services`**      | `apps/api/src/routes/services.ts`                              | None                     | Services route queries `services` and `service_versions` tables             | Yes (with Task 14) |
| **14 (P2)** | **Wire PostgreSQL Poller into Outbox Worker**          | `apps/worker/src/index.ts`, `packages/db`                      | None                     | Worker logs dispatching outbox rows directly from database                  | Yes (with Task 13) |
| **15 (P0)** | **Record YouTube Demo Video & Prepare Devpost**        | Video recorder, Devpost draft                                  | Tasks 5, 6, 9, 12        | 2:50 minute video uploaded; Devpost text covers all judging criteria        | No                 |

### Explicitly Deferred Features (Do NOT Implement for Hackathon)

- Multi-party PayPal commerce onboarding and marketplace split payouts.
- PayPal Vaulting and automated recurring billing subscriptions.
- BullMQ Redis queue worker (PostgreSQL outbox meets all reliability requirements).
- Full production machine-learning model retraining pipeline (heuristic models suffice).
- Complex multi-service dynamic scheduling (fixed duration MVP meets criteria).

---

## 23. Final Handoff Summary

```text
Current branch: feat/epic-3-paypal-sandbox
Current commit: 6d3c9f00d8d21a9bfca144cd42c52486ad7e961b
Working tree: M prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md (clean application code; uncommitted trailing blank line on prompt line 824)
Completed epics: Epic 1 (Platform Foundation), Epic 2 (Booking Concurrency & RLS), Epic 3 (PayPal & Financial Ledger)
Conditionally completed epics: None (Epic 3 verified against real PayPal Sandbox with balanced double-entry ledger)
Pending epics: Epic 4 (Agent Interfaces & Security Boundary), Epic 5 (Bryntum Scheduler, Forecast Viz, Abuse Lab UI & Judge Mode)
Backend readiness: AUTOMATED_VERIFIED (18 tasks, 12 packages, 190 tests passing, 0 lint/type errors)
Local website readiness: AUTOMATED_VERIFIED (React 19 SPA runs locally with PayPal JS SDK v6 component and booking simulator)
Hosted demo readiness: ABSENT (Render deployment blueprint not authored; temporary webhook ingress closed)
Agent-interface readiness: SCAFFOLDED (Tool registry has 6 tools registered; commit_booking disabled; MCP transport absent)
Bryntum readiness: ABSENT (@bryntum/scheduler package not installed; custom React state countdown used)
Submission readiness: SCAFFOLDED (Missing MIT LICENSE file, hosted URL, YouTube demo video, and Devpost copy)
Highest-risk unresolved issue: Repository lacks an open-source LICENSE file (P0 submission disqualifier) and has no hosted public URL (P1).
Recommended immediate next task: Add MIT LICENSE file, then proceed immediately with Epic 4 (Fastify Streamable HTTP MCP transport).
```
