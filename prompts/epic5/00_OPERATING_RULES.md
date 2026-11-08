# velvetAI Epic 5 — Operating Rules (read before every work package)

You are the implementation engineer for velvetAI, a booking and payments platform for the PayPal AI Hackathon. Every Epic 5 prompt file assumes you have read this file completely. If a work package prompt conflicts with this file, this file wins unless the work package explicitly says "overrides 00".

---

## 1. What velvetAI is (one paragraph)

velvetAI lets humans and AI agents book appointments at local businesses (salons, studios, wellness). AI agents (in-page Ask AI with Google Gemini, external MCP clients, WebMCP) can discover services, find slots, and PREPARE a booking hold. Only a signed-in HUMAN can APPROVE the booking on an approval page, and the deposit is paid through PayPal Sandbox (Orders v2, JS SDK v6). PostgreSQL guarantees no double booking (GiST exclusion constraint), tenant isolation (Row-Level Security), and a balanced double-entry ledger. Epic 5 turns this working engine into a polished, hosted, judge-ready product.

## 2. Hackathon facts that drive priorities

- Submission deadline: Thursday Nov 12, 2026, 12:00 PM Pacific (Fri Nov 13, 1:30 AM IST). Internal target: Nov 10.
- Feature freeze: Nov 6. After freeze: bug fixes, copy, accessibility, demo polish only.
- Judging: Dec 1–15, 2026. The hosted demo must work, free and unrestricted, until Dec 15.
- Judging criteria: Technological Implementation, Design (complete coherent product, not a proof of concept), Potential Impact, Innovation, Presentation (video under 3 minutes).
- Target prizes: Best Use of PayPal + AI, Best Use of Agentic Commerce, Best Use of Bryntum, Best Use of Render, Best Demo Delivery, overall placement.

## 3. Repository map (verify; do not assume)

Monorepo: pnpm workspaces + Turborepo, strict TypeScript, Node 24 LTS, ESM.

```text
apps/api            Fastify 5 REST API, MCP endpoint (/mcp), Ask AI (/v1/ai/chat), webhooks
apps/web            React 19 + Vite SPA (Auth0 SPA SDK, PayPal JS SDK v6, Ask AI drawer)
apps/worker         Outbox relay, hold reaper, payment reconciliation
apps/abuse-lab      Deterministic security scenarios and runner
packages/application  Use-case services (CatalogService, AvailabilityService, BookingService, PaymentService, AI ports)
packages/contracts  Zod/TS wire contracts (money.ts = canonical money)
packages/db         Kysely client, migrations, schema types, test-db helpers
packages/domain     Pure domain logic (booking states, catalog, policy)
packages/forecasting  Forecasting functions
packages/integrations-paypal  PayPal adapters (sandbox only)
packages/observability  Env validation, logging
packages/tool-registry  Versioned tool definitions shared by REST/MCP/Ask AI/WebMCP
```

Before writing new code in any area, run `rg` for the closest existing example and copy its patterns (file layout, naming, error handling, test style). In your report, name the example you copied.

Development tenant ID: `01932b10-0000-7000-8000-000000000001`.
Judge tenant ID (created in Epic 5 step 04): `01932b10-0000-7000-8000-000000000a01`.

## 4. Non-negotiable invariants

1. **No double booking:** the GiST exclusion constraint on `resource_claims` (tenant, resource, `blocked_during`, `WHERE blocking`) is the only authority. Never add application-level "check then insert" logic as a replacement.
2. **Tenant isolation:** every tenant table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy on `current_setting('app.tenant_id', true)`. Tenant context is set only with transaction-local `set_config('app.tenant_id', :id, true)` inside `withTenantTransaction`. The runtime DB role is not superuser and has no BYPASSRLS.
3. **Idempotency:** every new mutating HTTP route requires the `Idempotency-Key` header and must be added to the idempotency plugin's route list. Missing key → 400 `missing_idempotency_key`; same key + different body → 409 `idempotency_key_conflict`.
4. **Money:** `bigint` minor units in the database and domain. On the wire, use only the canonical shape from `packages/contracts/src/money.ts`: `{ valueMinor: "7500", currency: "USD" }` plus a server-formatted string. No floating-point money anywhere. Never display `$0.00` for missing data; display "Pricing unavailable".
5. **Time:** store and transmit UTC ISO 8601. Display booking times in the merchant/resource IANA time zone using the server-provided `display` fields from the time zone fix. The browser's zone is secondary ("Your time: ..."). Never compute business times in the browser zone.
6. **Two-phase human approval:** agents can prepare holds. Only an authenticated human buyer (Auth0 user token, not an M2M `@clients` token) can approve. AI callers can never commit (`COMMIT_NOT_PERMITTED_FOR_AI`). Raw confirmation tokens never appear in model context, URLs, logs, localStorage, or reports (not even partially).
   Canonical error code for a different buyer is `BUYER_MISMATCH` (some prompts say APPROVAL_BELONGS_TO_ANOTHER_BUYER; use BUYER_MISMATCH).
7. **Payment finality:** a booking is CONFIRMED only after the PayPal capture status (not the order status) is `COMPLETED`. Timeouts become `CAPTURE_UNCERTAIN`, keep the claim blocking, and are reconciled.
8. **PayPal is sandbox only.** Live credentials are rejected at startup. Do not change this.
9. **Append-only financial data:** never UPDATE or DELETE posted journal entries/lines, captures, refunds, or verified provider events.
10. **Judge-only features** (reset, fault injection, live abuse runs, demo fixtures) work only in the judge tenant and fail closed everywhere else, enforced in code AND by a database CHECK constraint where possible.
11. **Secrets:** never in source, `render.yaml`, logs, test snapshots, screenshots, reports, or the video. Never print tokens. Never ask the user to paste a secret into chat.
12. **Honest labels:** anything simulated, heuristic, synthetic, deterministic-model, or CI-only is labeled in the UI with plain words.

## 5. Coding rules for this project

- TypeScript strict. No `any`, no `@ts-ignore`, no `eslint-disable`, no `as unknown as X` unless you explain why in the report and there is no alternative.
- Never weaken, skip, delete, or `.only` a test to make the suite pass. If an existing test fails because the requirement changed, update it and explain the requirement change in the report.
- Never invent package names or versions. Check with `pnpm view <package> version` and the official docs. Pin exact versions (`--save-exact`).
- Do not touch files unrelated to the current work package. Do not reformat unrelated code.
- Errors from HTTP routes use the existing RFC 9457 Problem Details helper. Add new error codes to the existing error-code enum/list; do not invent a second error format.
- New tool behavior goes through `packages/tool-registry` so REST, MCP, Ask AI, and WebMCP stay equivalent. Extend `apps/api/src/__tests__/transport-equivalence.test.ts` when tool outputs change.
- UI copy is for customers and judges, not engineers. No words like "authoritative", "invariant", "claim", "GiST", "RLS" in customer screens. Technical words are allowed on `/judge` and `/security`.
- Accessibility: every status uses icon + text, not color alone. All buttons reachable by keyboard. Live updates use `aria-live="polite"`.
- Escape all user/merchant text you render (React does this by default; never use `dangerouslySetInnerHTML`; in Bryntum renderers return text or DomConfig, not HTML strings built from data).

## 6. Database migration rules

1. List `packages/db/src/migrations` and use the next number and the same file format (Kysely TypeScript `up`/`down`).
2. Every migration has a working `down`. Run up → down → up locally and in the migration lifecycle test.
3. New tenant tables: copy the RLS block from the most recent migration that created a tenant table. It must include: `tenant_id uuid not null`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, a policy using `current_setting('app.tenant_id', true)`, and grants to the runtime role, exactly like existing tables.
4. After adding tenant tables, update the documented RLS table count (README, docs) using a real query against `pg_tables`/`pg_class` (`relforcerowsecurity = true`), not by hand.
5. Run `pnpm db:test:prepare` after adding migrations so all per-package test databases are migrated.

## 7. Workflow for every work package

1. Create or switch to branch `feat/epic-5-judge-experience` (one branch for Epic 5 unless the user says otherwise).
2. Run the preconditions listed in the work package. If any fails, STOP and report.
3. Write a short plan (5–15 bullets) in your first message listing files you will create/modify.
4. Implement in small steps. After each step, run the narrowest relevant test (for example `pnpm --filter @velvetai/api test -- <file>`).
5. At the end run the full verification set:

```zsh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm turbo run test --force
pnpm build
git diff --check
```

`--force` is mandatory for the final test run (cached runs prove nothing).

6. Update `docs/implementation-progress.md` (Epic 5 section) and `docs/epic5-checklist.md` with status and evidence links.
7. Commit with a conventional message, for example `feat(web): buyer approval page with golden path`. Report the full SHA.
8. Do not push or merge to `main` unless the user asks. Pushing the feature branch is allowed when the user asks or when a Render deploy needs it.

## 8. When to stop and ask the user

Stop and ask (do not guess) when:

- You need a dashboard action (Auth0, PayPal Developer, Render, Google AI Studio, GitHub). Give exact click-by-click steps and tell the user which value to put in which env file. Never ask for the secret value itself.
- A precondition fails.
- The same error persists after two different fix attempts. Report the exact command, the error output, and your two hypotheses.
- A requirement seems to conflict with an invariant in section 4.
- A third-party API or package behaves differently from these prompts. Report what the official docs say, with the URL.

## 9. Status words (use exactly these)

- `NOT_STARTED`, `IN_PROGRESS`, `IMPLEMENTED` (code done, not fully verified), `VERIFIED` (automated tests + manual evidence passed), `BLOCKED` (with reason), `DEFERRED` (explicitly cut, with reason), `DEFERRED_EXTERNAL` (depends on something outside velvetAI).

## 10. Report template (end every work package with this)

```text
## Work package: <number and name>
Priority: P0/P1/P2
Status: VERIFIED / IMPLEMENTED / BLOCKED

### What shipped
- <bullet per user-visible or API-visible change>

### Files
- created: ...
- modified: ...

### Patterns copied from
- <existing file> for <what>

### Tests added
- <file>: <test name> — <what it proves>

### Verification
| Command | Exit | Result |
| pnpm format:check | | |
| pnpm lint | | |
| pnpm typecheck | | |
| pnpm turbo run test --force | | <N tests, duration> |
| pnpm build | | |
| git diff --check | | |

### Manual evidence
- <steps performed, sanitized output, screenshot paths under docs/evidence/>

### Honest gaps / labels
- <anything simulated, heuristic, CI-only, deferred>

### Section J demo items now satisfied
- <list from SPEC_V1_1_AMENDMENT.md J.4, items 1–10>

### Commit
- <full SHA>, git status --short: <clean or list>

### Calendar
- On track / at risk / late. If at risk: what to cut (from the work package's cut list).
```

## 11. Glossary

- **Hold:** a temporary reservation (300 seconds) that creates a blocking `resource_claims` row.
- **Signed intent:** an ES256 JWS describing exactly what will be booked and at what price. Integrity only; it does not prove human consent.
- **Approval locator:** a non-authorizing URL id (`loc_...`) that lets the buyer view terms. Knowing it must not allow approval.
- **Confirmation:** a one-time server-side record created when the human approves. Consumed exactly once by commit.
- **Commit:** turns an approved hold into a booking in `COMMITTING`, then the payment flow begins.
- **Booking states:** read the real enum in `packages/domain/src/booking.ts` and use those names exactly. Do not invent states.
- **Judge tenant:** a synthetic tenant used only for the hosted demo and judge tools.
