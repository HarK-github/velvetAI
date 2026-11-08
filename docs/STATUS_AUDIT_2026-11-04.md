# velvetAI Status Audit — 2026-11-04

SECRET HISTORY RISK: Unredacted Google Gemini API key (`AIzaSy...`) found in git commit history (`3a69c59` and `0e28782`) in `docs/setup/gemini.md`.

## 0. Headline (5 bullets max)

- Newest code is on: `feat/epic-4-agent-interfaces` @ `4b62274` (2026-10-26 22:46:48 +0530), pushed: yes (0 unpushed commits).
- Verification: format pass (0 diffs), lint pass (0 errors, 22 warnings), typecheck pass (19 tasks), test --force FAIL (385 passed, 2 failed, 1 hook timeout in `@velvetai/db`), build pass (12 packages).
- Epic 4 follow-ups done: E4-F1 (VERIFIED), E4-F2 (VERIFIED), E4-F3 (VERIFIED), E4-F4 (VERIFIED), E4-TZ (VERIFIED), E4-MCP (VERIFIED).
- Epic 5 packages done: None (WP 01–09 NOT_STARTED; prompt specs committed, no implementation code exists).
- Biggest blocker right now: Concurrency tests timing out in `@velvetai/db`, plus exposed Gemini API key in git history requiring revocation/scrubbing before public release.

## 1. Git topology

### Command Outputs

```text
$ pwd
/Users/ayu/Documents/github/velvetAI

$ git remote -v
origin	https://github.com/HarK-github/velvetAI.git (fetch)
origin	https://github.com/HarK-github/velvetAI.git (push)

$ git branch --show-current
feat/epic-4-agent-interfaces

$ git status --short
 M prompts/00_OPERATING_RULES.md

$ git stash list
<empty>

$ git worktree list
/Users/ayu/Documents/github/velvetAI 4b62274 [feat/epic-4-agent-interfaces]

$ git fetch --all --prune
Fetching origin (exit 0)

$ git branch -vv
  feat/epic-3-paypal-sandbox   08183c5 [origin/feat/epic-3-paypal-sandbox] feat: complete epic 3.5 integration hardening
* feat/epic-4-agent-interfaces 4b62274 [origin/feat/epic-4-agent-interfaces] docs(prompts): add Epic 5 judge experience prompts and runbooks (00-10, 99)
  main                         12d49e2 [origin/main] feat(web): integrate theme design system, multi-page router, and live console

$ git branch -r
  origin/HEAD -> origin/main
  origin/feat/epic-1-platform-foundation-persistence
  origin/feat/epic-3-paypal-sandbox
  origin/feat/epic-4-agent-interfaces
  origin/main

$ git log --oneline --decorate -25
4b62274 (HEAD -> feat/epic-4-agent-interfaces, origin/feat/epic-4-agent-interfaces) docs(prompts): add Epic 5 judge experience prompts and runbooks (00-10, 99)
1063cc0 feat(epic-4): enforce human buyer approval invariant and RFC 9728 MCP audience isolation
0e28782 feat(epic4): complete Epic 4 closeout C2-C7, test DB isolation, and external MCP client proof
3a69c59 feat(epic-4): complete Ask AI data-integrity and UX quality recovery pass
08183c5 (origin/feat/epic-3-paypal-sandbox, feat/epic-3-paypal-sandbox) feat: complete epic 3.5 integration hardening
6d3c9f0 docs(security): sanitize sandbox evidence and finalize epic 3
f1b3ca0 feat(epic-3): complete real PayPal sandbox E2E verification and ledger audit
c6282a8 feat(sandbox): load .env in server and pass VITE_PAYPAL_CLIENT_ID to web app
d58c154 docs(epic-3): update status terminology and standardize RUN_PAYPAL_SANDBOX_E2E test flag
3d626cb fix(epic-3): complete payment finality audit remediations and database ledger integrity
18c4f3b feat(epic-3): complete paypal sandbox integration and financial ledger reconciliation
191ca98 refactor(application): standardize on jose as the authoritative production JWS implementation
539d177 feat: complete concurrency-safe booking epic
b99bb40 chore: add start script alias to package.json
dbb60aa (origin/feat/epic-1-platform-foundation-persistence) feat(epic-1): complete Phase 0 and Sprint Epic 1 platform foundation
12d49e2 (origin/main, origin/HEAD, main) feat(web): integrate theme design system, multi-page router, and live console
4d6df25 feat(api): implement Fastify REST API, outbox worker, and security test suites
936c8c9 feat(packages): implement shared contracts, application ports, database, and observability
8fd5f50 chore(tooling): establish monorepo foundation, workspace, and tooling
1c97db8 docs(planning): initialize specifications and architecture decisions

$ git rev-list --left-right --count origin/main...HEAD
0	15

$ git log origin/main..HEAD --oneline | wc -l
15

$ git log HEAD..origin/main --oneline | wc -l
0
```

### Answers

- **Newest local branch**: `feat/epic-4-agent-interfaces` @ `4b622746cc43bc95ce47a0d8998bce041c72f526`, Date: `Mon Oct 26 22:46:48 2026 +0530`, Message: `docs(prompts): add Epic 5 judge experience prompts and runbooks (00-10, 99)`.
- **Pushed status**: Pushed to `origin` (`https://github.com/HarK-github/velvetAI.git`). Exactly 0 commits are unpushed.
- **Commits ahead of `origin/main`**: 15 commits ahead.
- **Commits 3a69c59 and 0e28782**: Both exist locally (`git cat-file -t` returns `commit`). Present on `feat/epic-4-agent-interfaces` and `origin/feat/epic-4-agent-interfaces`.
- **Uncommitted changes & stashes**: 0 stashes. Working tree contains modified `prompts/00_OPERATING_RULES.md` (168 lines of Epic 5 operating guidelines).
- **Other clones on machine**: `find ~ -maxdepth 5 -type d -iname velvetai 2>/dev/null` identified exactly 1 clone: `/Users/ayu/Documents/github/velvetAI`.

## 2. Verification results

### Toolchain Versions

- Node: `v22.23.3` (Note: `mise.toml` pins `node = "24.22.1"`, mismatch with host runtime)
- pnpm: `12.14.0`
- Docker: `Docker version 29.9.2, build a82e528`
- Docker Compose: daemon not running (`Cannot connect to the Docker daemon at unix:///Users/ayu/.docker/run/docker.sock`)

### Verification Commands

| Command                          | Exit | Duration | Summary                                                                                        |
| -------------------------------- | ---- | -------- | ---------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 0    | 0.29s    | Lockfile up to date, 13 workspace projects verified                                            |
| `pnpm db:test:prepare`           | 0    | 0.57s    | 7 per-package test databases prepared and migrated successfully                                |
| `pnpm format:check`              | 0    | 1.95s    | All matched files use Prettier code style                                                      |
| `pnpm lint`                      | 0    | 0.25s    | 19 tasks successful (0 errors, 22 warnings in contracts/db/web/tool-registry/api)              |
| `pnpm typecheck`                 | 0    | 0.28s    | 19 tasks successful, 0 TypeScript errors                                                       |
| `pnpm turbo run test --force`    | 1    | 1m 40s   | 18 successful tasks, 1 failed task (`@velvetai/db:test`). 385 passed, 2 failed, 1 hook timeout |
| `pnpm build`                     | 0    | 0.26s    | 12 packages built successfully                                                                 |
| `git diff --check`               | 0    | 0.01s    | Zero whitespace or newline formatting issues                                                   |

#### Detailed Test Results per Package (`pnpm turbo run test --force`)

- `@velvetai/abuse-lab`: 2 files passed (2) | 53 passed (53)
- `@velvetai/api`: 9 files passed (9) | 82 passed (82)
- `@velvetai/application`: 9 files passed (9) | 72 passed (72)
- `@velvetai/contracts`: 4 files passed (4) | 31 passed (31)
- `@velvetai/db`: 1 file failed, 5 passed (6) | 2 failed, 34 passed (36). Failures: `src/__tests__/concurrency-booking.test.ts` (Test 1 timed out in 30000ms, Test 2 timed out in 30000ms, afterAll hook timed out in 10000ms)
- `@velvetai/domain`: 1 file passed (1) | 12 passed (12)
- `@velvetai/forecasting`: 1 file passed (1) | 4 passed (4)
- `@velvetai/integrations-paypal`: 1 file passed (1) | 18 passed (18)
- `@velvetai/observability`: 1 file passed (1) | 3 passed (3)
- `@velvetai/tool-registry`: 1 file passed (1) | 4 passed (4)
- `@velvetai/web`: 9 files passed (9) | 58 passed (58)
- `@velvetai/worker`: 3 files passed (3) | 14 passed (14)

## 3. Documents claim

- `docs/implementation-progress.md`:
  - Current phase: Sprint Epic 4 — Agent Interfaces & Security Boundary (Acceptance Audit & Remediation Pass).
  - Epic status: Epic 1 (VERIFIED), Epic 2 (VERIFIED), Epic 3 (VERIFIED), Epic 3.5 (VERIFIED), Epic 4 (ACCEPTED), Epic 5 (NOT_STARTED).
  - Listed blockers: None ("Active blockers: None. Epic 4 accepted").
  - Verification: Claims 19/19 automated verification tasks pass, Auth0 real E2E passes, Gemini real E2E passes, MCP external client 10/10 passes.
  - Scope guard: "Bryntum, forecasting UI, Abuse Lab UI, Judge Mode, live PayPal... remain strictly out of scope."
- `docs/EPIC4_WEBSITE_STATUS.md`:
  - Overview (`/`): WORKING_REAL_E2E (static & client math).
  - Book Slot (`/book`): WORKING_REAL_E2E (real API, PostgreSQL 17 `services` and `resource_claims`).
  - Schedule (`/schedule`): UI_ONLY (in-memory schedule state, client-side simulation).
  - Policy (`/policy`): WORKING_REAL_E2E (pure domain deterministic model).
  - Status (`/status`): WORKING_REAL_E2E (Fastify `/health/live`, `/health/ready`).
  - Login/Logout: WORKING_REAL_E2E (Auth0 hosted login + PostgreSQL `app_users`/`memberships`).
  - Ask AI Drawer: WORKING_REAL_E2E (Gemini live / deterministic fake provider).
  - PayPal Button: WORKING_REAL_E2E (PayPal Sandbox v2 + PostgreSQL ledger).
  - Two-Phase Approval (`/approve/:locator`): WORKING_REAL_E2E (Auth0 buyer session + `buyer_confirmations`).
  - Cancellation & Attendance: WORKING_AUTOMATED_ONLY (application layer APIs working, UI deferred).
- `docs/epic5-checklist.md`: File does not exist.
- `docs/submission/DEADLINES.md`: File does not exist.
- Files in `prompts/` (last commit dates):
  - `00_OPERATING_RULES.md` through `10_JUDGING_PERIOD_MAINTENANCE.md`, `99_FAILURE_RECOVERY.md`, `README_HOW_TO_USE.md`: 2026-10-26
  - `EPIC4_FINAL_FIXES.md`: 2026-10-26
  - `EPIC4_ACCEPTANCE_AUDIT.md`, `EPIC4_AGENT_INTERFACES_PROMPT.md`, `EPIC4_ASK_AI_RECOVERY.md`, `EPIC4_ASK_AI_TIMEZONE_UX_FIX.md`, `EPIC4_CLOSEOUT.md`, `EPIC5_JUDGE_EXPERIENCE_PROMPT.md`: 2026-10-23
  - `EPIC3_5_INTEGRATION_HARDENING.md`, `EPIC3_ACCEPTANCE_AUDIT.md`, `EPIC3_PAYPAL_INTEGRATION_PROMPT.md`, `REPOSITORY_STATUS_AUDIT_PROMPT.md`: 2026-10-22
  - `EPIC2_BOOKING_PROMPT.md`: 2026-10-21
  - `prompts/epic5/`: Directory does not exist (all prompts reside directly under `prompts/`).
- Files in `docs/evidence/` and `docs/decisions/`:
  - `docs/evidence/`: `mcp-external-client.md`
  - `docs/decisions/`: `0001-modular-monolith.md`, `0002-postgresql-as-authority.md`, `0003-transactional-outbox.md`, `0004-oidc-authentication-boundary.md`, `0005-concurrency-safe-booking-and-signed-intents.md`, `0006-paypal-payment-finality-and-reconciliation.md`, `0007-agent-interfaces-auth0-and-stateless-mcp.md`.

## 4. Code reality

### Epic 4 follow-ups

| ID     | Found | Evidence (file:line / test)                                                                                                                                                            | Status   |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| E4-F1  | FOUND | `apps/api/src/routes/bookings.ts:177-240`, `packages/application/src/booking-service.ts:568-572`, `apps/abuse-lab/src/transport-scenarios.ts:397,417`                                  | VERIFIED |
| E4-F2  | FOUND | `apps/api/src/plugins/auth.ts:473`, `apps/api/src/routes/mcp.ts:196,223`, `packages/observability/src/env.ts:75`, test in `apps/api/src/__tests__/mcp.test.ts:320`                     | VERIFIED |
| E4-F3  | FOUND | Zero occurrences of fixed passwords in code; `apps/api/src/routes/ai.ts:2,294` (`stepCountIs(5)`)                                                                                      | VERIFIED |
| E4-F4  | FOUND | `packages/application/src/booking-service.ts:750`, test in `apps/api/src/__tests__/mcp.test.ts:774`                                                                                    | VERIFIED |
| E4-TZ  | FOUND | `packages/contracts/src/availability.ts:36`, `packages/application/src/availability-service.ts:214,218`, test in `packages/application/src/__tests__/catalog-availability.test.ts:551` | VERIFIED |
| E4-MCP | FOUND | `scripts/mcp-external-smoke.ts`, `package.json:23`, documented run in `docs/evidence/mcp-external-client.md`                                                                           | VERIFIED |

_Note on E4-F1:_ Route requires `authorization` header (401 `HUMAN_APPROVAL_REQUIRED`), rejects M2M clients ending in `@clients` (403 `HUMAN_APPROVAL_REQUIRED`), rejects dev tokens outside test (403 `HUMAN_APPROVAL_REQUIRED`), requires `BUYER` or `OWNER` role, and rejects mismatched buyer with 403 `BUYER_MISMATCH` (code uses `BUYER_MISMATCH`, not `APPROVAL_BELONGS_TO_ANOTHER_BUYER`). Matching Abuse Lab scenarios: `transport-11` and `transport-12`.

### Epic 5 work packages

| ID                              | Found     | Evidence                                                                                                                                                                                                                          | Status      |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 01 Baseline docs                | NOT_FOUND | `docs/epic5-checklist.md` and `docs/submission/DEADLINES.md` missing                                                                                                                                                              | NOT_STARTED |
| 02 Approval page & golden path  | PARTIAL   | `apps/web/src/pages/ApprovalPage.tsx` exists; `approve-and-commit`, `ALREADY_COMMITTED`, and Playwright tests missing                                                                                                             | NOT_STARTED |
| 03 Render deployment            | PARTIAL   | `render.yaml` exists; live deploy evidence, `AI_DAILY_TURN_BUDGET`, and `ai_rate_limited` missing                                                                                                                                 | NOT_STARTED |
| 04 Judge tenant & reset         | NOT_FOUND | No references to `000000000a01`, `JUDGE_TENANT_ID`, `judge_runs`, or `/v1/judge/reset` in code                                                                                                                                    | NOT_STARTED |
| 05 Bryntum scheduler            | NOT_FOUND | `@bryntum` not in `package.json`, `BryntumScheduler` missing, `/v1/merchant/schedule` missing, `THIRD_PARTY_NOTICES.md` missing                                                                                                   | NOT_STARTED |
| 06 Forecasting                  | PARTIAL   | Baseline statistical functions (`predictNoShowProbability`, `predictSlotFillProbability`, `calculateBrierScore`, `calculateWAPE`) exist in `packages/forecasting`; `forecast_snapshots`, `pricingBasis`, and `weak-slots` missing | NOT_STARTED |
| 07 Security dashboard           | NOT_FOUND | `apps/web/src/data/abuse-lab-report.json`, `/v1/judge/abuse-lab`, and security dashboard component missing                                                                                                                        | NOT_STARTED |
| 08 Judge page & fault injection | NOT_FOUND | `judge_fault_flags`, `DROP_NEXT_CAPTURE_RESPONSE`, `/proof`, and Judge page component missing                                                                                                                                     | NOT_STARTED |
| 09 Submission docs              | NOT_FOUND | `docs/submission/` missing; `README.md:84` still mentions TanStack Router/Query                                                                                                                                                   | NOT_STARTED |

### Other facts

- **Latest migration**: `0005_self_membership_rls.ts` in `packages/db/src/migrations/`.
- **Web routes and data source**:
  - `/` (`HomePage.tsx`): Static overview and SVG math choreography.
  - `/book` (`BookingPage.tsx`): Real API data (`GET /v1/services`, `GET /v1/availability`, `POST /v1/bookings/holds`, `POST /v1/bookings/commit`, PayPal JS SDK v6).
  - `/schedule` (`SchedulePage.tsx`): UI_ONLY client-side ticker & simulated race.
  - `/policy` (`PolicyPage.tsx`): In-memory deterministic model sliders.
  - `/status` (`StatusPage.tsx`): Real API telemetry (`GET /health/live`, `GET /health/ready`).
  - `/approve/:locator` (`ApprovalPage.tsx`): Real API data (`GET /v1/booking-approvals/:locator`, `POST /v1/booking-approvals/:locator/confirm`).
  - Ask AI Drawer (`AskAIDrawer.tsx`): Real API chat (`POST /v1/ai/chat`, `GET /v1/ai/status`).
- **Abuse Lab scenarios by severity**: 52 total (26 CRITICAL, 24 HIGH, 2 MEDIUM) across `apps/abuse-lab/src/scenarios.ts` (29) and `apps/abuse-lab/src/transport-scenarios.ts` (23).
- **RLS tables (migrations count / DB count)**: Migrations define 25 unique tables (16 in `0002_slot_claim_rls_hardening.ts` + 9 in `0003_payment_core_ledger.ts`). Real count in local PostgreSQL `velvetai_test` database is exactly 25 (`relrowsecurity and relforcerowsecurity = true`).

## 5. Local runtime

### Endpoint Probing Outputs

```text
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health/live
200

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/health/ready
200

$ curl -s http://localhost:3000/v1/ai/status
{"provider":"gemini","model":"gemini-3.5-flash-lite","realProviderConfigured":true,"realProviderVerified":false}

$ curl -s http://localhost:3000/.well-known/oauth-protected-resource
{"resource":"https://velvetai.example/api","authorization_servers":["https://dev-o55m2ek822mgtiim.us.auth0.com/"],"bearer_methods_supported":["header"],"scopes_supported":["booking:read","booking:quote","booking:prepare","booking:commit","booking:cancel","merchant:schedule","merchant:refund"]}

$ curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp
{"resource":"http://localhost:3000/mcp","authorization_servers":["https://dev-o55m2ek822mgtiim.us.auth0.com/"],"bearer_methods_supported":["header"],"scopes_supported":["booking:read","booking:quote","booking:prepare","booking:commit"]}

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
200
```

### Environment Files Check

```text
== .env
NODE_ENV=<set>
PORT=<set>
HOST=<set>
LOG_LEVEL=<set>
DATABASE_URL=<set>
DATABASE_POOL_MIN=<set>
DATABASE_POOL_MAX=<set>
REDIS_URL=<set>
OIDC_ISSUER=<set>
OIDC_AUDIENCE=<set>
OIDC_MOCK_ENABLED=<set>
AUTH0_ISSUER=<set>
AUTH0_AUDIENCE=<set>
AUTH0_JWKS_URI=<set>
INTENT_SIGNING_KEY=<set>
CONFIRMATION_TOKEN_SECRET=<set>
ENVELOPE_ENCRYPTION_KEY=<set>
PAYPAL_CLIENT_ID=<set>
PAYPAL_CLIENT_SECRET=<set>
PAYPAL_ENVIRONMENT=<set>
VITE_PAYPAL_CLIENT_ID=<set>
PAYPAL_WEBHOOK_ID=<set>
WEB_BASE_URL=<set>
API_BASE_URL=<set>
VITE_AUTH0_DOMAIN=<set>
VITE_AUTH0_CLIENT_ID=<set>
VITE_AUTH0_AUDIENCE=<set>
POSTGRES_USER=<set>
POSTGRES_PASSWORD=<set>
POSTGRES_DB=<set>
TEST_DATABASE_URL=<set>

== .env.local
NODE_ENV=<set>
PORT=<set>
HOST=<set>
LOG_LEVEL=<set>
DATABASE_POOL_MIN=<set>
DATABASE_POOL_MAX=<set>
REDIS_URL=<set>
OIDC_ISSUER=<set>
OIDC_AUDIENCE=<set>
OIDC_MOCK_ENABLED=<set>
AUTH0_ISSUER=<set>
AUTH0_AUDIENCE=<set>
AUTH0_JWKS_URI=<set>
AI_PROVIDER=<set>
GOOGLE_GENERATIVE_AI_API_KEY=<set>
AI_MODEL=<set>
INTENT_SIGNING_KEY=<set>
CONFIRMATION_TOKEN_SECRET=<set>
ENVELOPE_ENCRYPTION_KEY=<set>
ALLOWED_HOSTS=<set>
ALLOWED_ORIGINS=<set>
PAYPAL_CLIENT_ID=<set>
PAYPAL_CLIENT_SECRET=<set>
PAYPAL_ENVIRONMENT=<set>
PAYPAL_WEBHOOK_ID=<set>
WEB_BASE_URL=<set>
API_BASE_URL=<set>
VITE_AUTH0_DOMAIN=<set>
VITE_AUTH0_CLIENT_ID=<set>
VITE_AUTH0_AUDIENCE=<set>
DATABASE_URL=<set>
TEST_DATABASE_URL=<set>
AUTH0_AGENT_CLIENT_ID=<set>
AUTH0_AGENT_CLIENT_SECRET=<set>

== .env.test
NODE_ENV=<set>
DATABASE_URL=<set>
TEST_DATABASE_URL=<set>
OIDC_MOCK_ENABLED=<set>

$ git check-ignore .env .env.local .env.test
.env
.env.local
```

_(Notice: `.env.test` is not gitignored; it contains unauthenticated localhost connection strings without credentials)._

## 6. Hosted and external

| Item                   | Status                                 | Evidence / ASK_USER                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Render                 | NOT_DEPLOYED (Scaffold only)           | `render.yaml` valid, zero secrets. Docs contain template URLs (`https://<your-api-url>.onrender.com`, `https://velvetai.onrender.com`). No active deploy evidence in `docs/evidence/`.                                                                                                                                                                             |
| PayPal Sandbox Webhook | NOT_REGISTERED (Local proof completed) | `docs/implementation-progress.md:291-292` notes temporary tunnel was closed and webhook registration removed post-verification. Runbook `docs/runbooks/paypal-sandbox-e2e.md:133` documents template endpoint.                                                                                                                                                     |
| Auth0                  | CONFIGURED (Hosted tenant active)      | Callback URLs documented: `http://localhost:5173, http://localhost:5173/callback, https://velvetai.onrender.com, https://velvetai.onrender.com/callback`. Second "velvetAI MCP" API: Not documented as separate API (configured as M2M client under primary API). Dedicated judge user: Not documented; provisioned on-demand via `pnpm auth:provision-test-user`. |
| Gemini                 | CONFIGURED (`gemini-3.5-flash-lite`)   | Active model is `gemini-3.5-flash-lite`. Provider is `gemini`. Confirmed via `GET /v1/ai/status`.                                                                                                                                                                                                                                                                  |
| Bryntum                | NOT_INSTALLED                          | Zero references to `@bryntum` in `apps/web/package.json` or root `package.json`.                                                                                                                                                                                                                                                                                   |
| GitHub                 | ASK_USER                               | Repository `https://github.com/HarK-github/velvetAI` returns 404 to non-collaborators (private). Root contains MIT [LICENSE](file:///Users/ayu/Documents/github/velvetAI/LICENSE).                                                                                                                                                                                 |

## 7. Security hygiene

- **SECRET HISTORY RISK**:
  - Commits `3a69c59` and `0e28782` contain an unredacted Google Generative AI API key (`AIzaSy...`) in `docs/setup/gemini.md`.
  - The key has since been replaced in `HEAD` with `AIzaSy...` in `docs/setup/gemini.md:29`, but the full key remains visible in git commit history.
  - Zero private keys (`BEGIN PRIVATE KEY`) or PayPal client secrets were found committed in git history (placeholders or redactions used).

## 8. Mismatches between documents and code

| Document claim                                                               | Reality                                                         | Evidence                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `docs/implementation-progress.md:9` claims all automated tests pass          | `@velvetai/db#test` fails under `--force` with 2 timeout errors | `pnpm turbo run test --force` exits with code 1 (`concurrency-booking.test.ts`) |
| `00_OPERATING_RULES.md` and `mise.toml` specify Node 24 LTS                  | System Node version is v22.23.3                                 | `node --version` outputs `v22.23.3`                                             |
| `README.md:84` describes React 19 with TanStack Router/Query                 | Web app uses custom lightweight context router                  | `apps/web/src/router.tsx`, no TanStack packages in `apps/web/package.json`      |
| `prompts/EPIC4_FINAL_FIXES.md` specifies `APPROVAL_BELONGS_TO_ANOTHER_BUYER` | Code throws `BUYER_MISMATCH`                                    | `packages/application/src/booking-service.ts:568-572`                           |
| `docs/implementation-progress.md:19` says "Do not begin Epic 5"              | Epic 5 prompt runbooks (00–10, 99) were committed in `4b62274`  | `prompts/` contains 12 Epic 5 files; `00_OPERATING_RULES.md` modified locally   |

## 9. Failing or broken things observed (facts only, no fixes)

| Area                 | Symptom                                                                            | Command / file                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@velvetai/db` tests | Test 1 and Test 2 timed out after 30000ms; `afterAll` hook timed out after 10000ms | `pnpm turbo run test --force` (`packages/db/src/__tests__/concurrency-booking.test.ts`)                  |
| Docker Daemon        | Cannot connect to Docker daemon socket; daemon inactive                            | `docker compose ps` (`Cannot connect to the Docker daemon at unix:///Users/ayu/.docker/run/docker.sock`) |
| Git History Secrets  | Live Gemini API key committed in history                                           | Git commits `3a69c59` and `0e28782` in `docs/setup/gemini.md`                                            |
| Git Tracking         | `.env.test` is tracked in git repository                                           | `git check-ignore .env.test` returns empty; file committed in git                                        |

## 10. Questions for the user

- Is `https://github.com/HarK-github/velvetAI` intended to remain private with judges invited as collaborators, or will it be converted to public before the Nov 12 deadline?
- Has the Google Generative AI API key exposed in commits `3a69c59` and `0e28782` been rotated/revoked in Google AI Studio, and should git history be scrubbed before making the repository public?
- Would you like the timeout setting in `packages/db/src/__tests__/concurrency-booking.test.ts` (100 concurrent DB operations on local PostgreSQL) increased from 30s to allow reliable `--force` test passes on this machine?
