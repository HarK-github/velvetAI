# velvetAI Epic 4 Closeout Prompt

```text
Act as the velvetAI Epic 4 Closeout Lead and release-evidence auditor.

CURRENT PHASE

Sprint Epic 4 — Agent Interfaces and Security Boundary (Closeout)

The Ask AI Data-Integrity & UX Quality Pass is ACCEPTED.
Epic 4 is CONDITIONAL. This closeout is time-boxed to one working day.
Its only purpose is to remove the remaining conditions so Epic 5 can start on a clean, honest baseline.

Do not start Epic 5.
Do not install Bryntum.
Do not build scheduler, forecasting UI, Abuse Lab UI, Judge Mode, or deployment changes.

READ FIRST

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. @docs/EPIC4_WEBSITE_STATUS.md
5. @docs/decisions/0007-agent-interfaces-auth0-and-stateless-mcp.md
6. @prompts/EPIC4_ASK_AI_RECOVERY.md
7. packages/db/src/test-db.ts, apps/api/src/env-loader.ts, every vitest config, turbo.json
8. apps/api/src/routes/mcp.ts and packages/tool-registry/src/registry.ts

==================================================
C1 — COMMIT THE QUALITY PASS
==================================================

1. Run: pnpm format:check, pnpm lint, pnpm typecheck, pnpm test, pnpm build, git diff --check.
2. Commit the Ask AI quality pass with a conventional message.
3. Report the exact commit SHA and `git status --short` (must be empty).

==================================================
C2 — PROGRESS DOCUMENT CONTRADICTIONS
==================================================

docs/implementation-progress.md currently contradicts itself. Fix every item below. Do not add new claims.

1. "Phase Progress Summary" Epic 4 row still says external integration is BLOCKED for "Hosted Auth0 credentials, Google Gemini API key". Auth0 and Gemini are VERIFIED. Only the external MCP client and native WebMCP remain.
2. "Epic 4 Status Summary" still lists Gemini Real-E2E as BLOCKED / NOT_RUN.
3. W5 still says the default model is `gemini-2.5-flash`, says `maxSteps: 5`, and says Live Gemini is BLOCKED. Correct to the actual code: the configured model from AI_MODEL (`gemini-3.5-flash-lite`) and AI SDK 7 `stopWhen: stepCountIs(5)` (or whatever the code actually uses — quote the code).
4. W8 `real_gemini_gate` must state the actual verified result and date.
5. The "Exact Output of `git status --short`" block under "Final Acceptance Verification Clarifications" is a stale Epic 2 snapshot. Label it "Historical Epic 2 snapshot (superseded)" or remove it. The current git status belongs only in the Workspace Verification Summary, with the commit SHA from C1.
6. Remove "Hosted Auth0 credentials" and "Google Gemini API key" from every remaining blocker list.
7. Add one line per status claim pointing to its evidence (test file, script, or runbook).

Run: rg -n "BLOCKED|NOT_RUN|gemini-2.5|maxSteps" docs/ and report every remaining hit with a justification.

==================================================
C3 — TEST DATABASE ISOLATION UNDER TURBO PARALLELISM
==================================================

`fileParallelism: false` was only added to apps/api. Turborepo still runs the `test` tasks of @velvetai/db, @velvetai/application, @velvetai/api, @velvetai/worker and @velvetai/abuse-lab in parallel against the same `velvetai_test` database. The migration lifecycle tests run down/up migrations, so this can produce intermittent failures or wipe another package's fixtures mid-run.

Choose ONE approach and document it in an ADR addendum or in docs/testing.md:

A (preferred): one test database per package, e.g. velvetai_test_db, velvetai_test_application, velvetai_test_api, velvetai_test_worker, velvetai_test_abuse_lab. getTestDatabaseUrl(packageName) derives the name. A global setup creates the database if missing and runs migrations. The safety guards still require the `_test` naming rule.
B: serialize database-backed test tasks (for example `turbo run test --concurrency=1` for DB packages only) and justify the CI time cost.

Also answer explicitly:

1. Does .env.test contain a password? If it is committed, it must contain no secrets (use the same local-only docker compose variables, or derive the URL from POSTGRES_* at runtime). If it is gitignored, document how a fresh clone and CI create it.
2. Is there a single command that prepares the test database(s) from a fresh clone (for example `pnpm db:test:prepare`)? Add it if missing and document it in README.
3. Is the migration lifecycle test the only test that runs down migrations? Make sure it cannot run concurrently with fixture-based tests against the same database.

Evidence required: run `pnpm test` three consecutive times from a clean state with zero failures, and report the durations.

==================================================
C4 — REMOVE SILENT STATIC FALLBACK ON BOOKING PAGE
==================================================

docs/EPIC4_WEBSITE_STATUS.md says Book Slot uses PostgreSQL "with static fallback".

A buyer must never see services or slots that the API did not return. If the API is unreachable:

- Show a visible error state with Retry.
- Never render static or mock services as if they were bookable.
- If a demo-only fallback must remain for local development, gate it behind an explicit dev flag that is off by default and display a visible "Offline demo data — not bookable" banner.

Add a web test proving that an API failure renders the error state, not mock cards.

==================================================
C5 — EXTERNAL MCP CLIENT PROOF (REAL PROCESS, REAL HTTP)
==================================================

The stateless MCP endpoint has only been proved by in-process tests. Prove it from a separate process over real HTTP.

1. Agent identity:
   - Preferred: an Auth0 Machine-to-Machine application authorized for the velvetAI API audience using the client-credentials grant. Its token `sub` is `<client_id>@clients`.
   - Provision a local PostgreSQL app_users + memberships row for that subject in the development tenant with only the scopes an agent needs (booking:read, booking:quote, booking:prepare, booking:commit). Reuse or extend `pnpm auth:provision-test-user` (for example `pnpm auth:provision-agent-client`).
   - Give the user exact Auth0 dashboard steps (Applications -> Create Application -> Machine to Machine -> authorize velvetAI API -> select scopes). The user will put AUTH0_AGENT_CLIENT_ID and AUTH0_AGENT_CLIENT_SECRET in .env.local only. Never print or log the token or secret.

2. Add `scripts/mcp-external-smoke.ts` (`pnpm mcp:smoke`) that runs as its own Node process, uses the official MCP v2 client package from the same release line as the pinned server packages (verify the exact package name and version from npm; do not guess), and calls http://localhost:3000/mcp over real HTTP with revision 2026-07-28 and the M2M bearer token:
   a. tools/list -> expect the 8 versioned tools with closed schemas.
   b. list_services.v1 -> 3 canonical services with canonical money.
   c. find_available_slots.v1 for tomorrow.
   d. prepare_booking.v1 -> HELD, approval locator, no raw confirmation token anywhere in the response.
   e. commit_booking.v1 before approval -> fails with APPROVAL_INCOMPLETE.
   f. Pause and print the approval locator URL. The human opens it and approves through the existing approval endpoint. Label this honestly as "API-level approval; styled approval page arrives in Epic 5 W1".
   g. commit_booking.v1 after approval -> succeeds once.
   h. Replay the same commit with a new idempotency key -> fails closed with CONFIRMATION_REPLAY_BLOCKED / isError.
   i. Request with a missing or wrong protocol revision -> rejected.
   j. Request without a bearer token -> 401 with WWW-Authenticate pointing at the protected resource metadata.
3. Also try MCP Inspector (or one desktop MCP client) against the endpoint for at most 30 minutes. If the client does not support revision 2026-07-28 stateless transport, record that exact finding with the client version. Do not weaken the server to accommodate an older revision.
4. Save sanitized output (no tokens, no secrets, IDs truncated) to docs/evidence/mcp-external-client.md with timestamp and commit SHA.

==================================================
C6 — WEBMCP STATUS
==================================================

Native WebMCP is a browser-availability dependency, not a velvetAI defect.

1. If a Chromium build with the WebMCP flag is available, spend at most 30 minutes verifying `document.modelContext` registration and one read-only tool call. Record the browser version and flag.
2. Otherwise mark it DEFERRED_EXTERNAL (simulation verified; standard UI and Ask AI remain the supported paths). It is no longer an Epic 4 blocker.

==================================================
C7 — EPIC 4 ACCEPTANCE DECISION
==================================================

Mark Epic 4 ACCEPTED only if C1–C5 pass. Otherwise keep CONDITIONAL and list the exact failing item.

Update docs/implementation-progress.md and docs/EPIC4_WEBSITE_STATUS.md, commit, and report.

==================================================
FINAL REPORT FORMAT
==================================================

1. Commit SHA(s) and final `git status --short`.
2. C2: list of corrected contradictions and the remaining rg hits with justification.
3. C3: chosen isolation approach, .env.test answers, three test-run durations.
4. C4: fallback behaviour and test name.
5. C5: sanitized MCP smoke output (steps a–j pass/fail) and the Inspector/desktop-client finding.
6. C6: WebMCP status.
7. Full command table: format:check, lint, typecheck, test, build, git diff --check.
8. Epic 4 decision: ACCEPTED or CONDITIONAL with reason.

Never print secrets, tokens, raw confirmation tokens, or PII.
```
