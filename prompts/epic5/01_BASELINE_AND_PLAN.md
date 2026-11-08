# Epic 5 · Work Package 01 — Baseline, Plan, and Checklist

Priority: P0 · Time box: half a day · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

Start Epic 5 from a verified clean baseline, write the Epic 5 ADR, and create the checklist that every later work package updates. No product code changes in this package.

## Preconditions (run and report each)

```zsh
git status --short                       # must be empty
git log --oneline -5                     # report
pnpm install --frozen-lockfile
pnpm db:test:prepare
pnpm format:check && pnpm lint && pnpm typecheck
pnpm turbo run test --force
pnpm build
```

Also confirm from `docs/implementation-progress.md` that:

1. Epic 4 is ACCEPTED.
2. `prompts/EPIC4_FINAL_FIXES.md` F1–F4 are VERIFIED. In particular F1: the approval confirm route rejects M2M tokens, missing tokens, and other buyers.
3. `prompts/EPIC4_ASK_AI_TIMEZONE_UX_FIX.md` is VERIFIED: slot tools return `display` fields in the merchant time zone.

If any of these is not true, STOP and report which one.

## Tasks

### 1. Branch

```zsh
git switch -c feat/epic-5-judge-experience
```

### 2. Read and summarize (in your first message, max 25 bullets)

Read: `spec.md`, `SPEC_V1_1_AMENDMENT.md` (especially Section J), `docs/implementation-progress.md`, `docs/EPIC4_WEBSITE_STATUS.md`, `docs/setup/bryntum-render-setup.md`, `docs/DEPLOYMENT.md`, `render.yaml`, `docs/runbooks/paypal-sandbox-e2e.md`, the booking state enum in `packages/domain/src/booking.ts`, and the public API of `packages/forecasting`.

Summarize:

- The exact booking state names.
- Which existing web pages exist and their status.
- What `packages/forecasting` already exports (function names and signatures).
- What `render.yaml` currently defines.
- The current latest migration number.
- Which roles/permissions exist in memberships (for example buyer, merchant, scheduler) and where they are defined.

### 3. ADR 0008

Create `docs/decisions/0008-judge-mode-scheduler-forecasts-and-hosting.md` using the same template as ADR 0007. Decisions to record:

1. A dedicated judge tenant `01932b10-0000-7000-8000-000000000a01` holds all hosted demo data. Judge-only features are enforced in code and by database CHECK constraints that compare `tenant_id` to this literal UUID.
2. Judge reset deletes only judge-tenant demo fixtures and derived data. It never deletes financial rows or rows linked to real sandbox payments; those are retained and reported.
3. The Bryntum Scheduler reads a dedicated read model endpoint (`GET /v1/merchant/schedule`); it never reads tables directly or computes availability itself.
4. Forecasts are deterministic heuristics with explainable integer factors (basis points), versioned as `heuristic-v1`, stored in `forecast_snapshots`. They are labeled as heuristics in the UI.
5. Abuse Lab dashboard shows two evidence types: CI-verified (exported JSON from the test run, tagged with commit SHA) and live run (curated safe scenarios executed against the judge tenant).
6. Hosting on Render: static web site, API web service, background worker, managed PostgreSQL, using paid instance types funded by hackathon credits so nothing sleeps or expires during judging.
7. Fault injection ("drop the next capture response") exists only for the judge tenant, as a one-shot armed flag.

Status: Accepted.

### 4. Checklist

Create `docs/epic5-checklist.md` with this table and keep it updated in every later package:

```markdown
| #   | Requirement (SPEC_V1_1_AMENDMENT J.4 unless noted)     | Work package | Status | Evidence |
| --- | ------------------------------------------------------ | ------------ | ------ | -------- |
| 1   | AI-assisted service/slot discovery                     | 02           |        |          |
| 2   | Forecast-bounded deposit                               | 06           |        |          |
| 3   | Explicit buyer terms approval                          | 02           |        |          |
| 4   | PayPal sandbox approval and capture                    | 02           |        |          |
| 5   | Verified webhook confirmation                          | 03           |        |          |
| 6   | Bryntum schedule update                                | 05           |        |          |
| 7   | Slot-hoarding and prompt-injection attempts blocked    | 07           |        |          |
| 8   | Injected capture-response loss reconciled              | 08           |        |          |
| 9   | Weak slot surfaced by fill forecast                    | 06           |        |          |
| 10  | Waitlist or targeted action improving the schedule     | 06 (P2)      |        |          |
| J.1 | Isolated judge tenant + reset                          | 04           |        |          |
| J.2 | Bryntum operational surface                            | 05           |        |          |
| J.3 | Technical proof panel                                  | 08           |        |          |
| —   | Hosted on Render, stable webhook                       | 03           |        |          |
| —   | README, Devpost text, video script, judge instructions | 09           |        |          |
```

### 5. Progress document

Add an "Epic 5" section to `docs/implementation-progress.md` with work packages 01–09 listed as NOT_STARTED except 01.

### 6. Calendar

Add `docs/submission/DEADLINES.md`:

```markdown
# Deadlines (source: https://paypalaihackathon.devpost.com/rules)

- Submission closes: Thu Nov 12, 2026, 12:00 PM Pacific (Fri Nov 13, 1:30 AM IST)
- Internal submission target: Tue Nov 10, 2026
- Feature freeze: Fri Nov 6, 2026
- Judging: Tue Dec 1, 2026 2:00 PM PT – Tue Dec 15, 2026 8:00 AM PT
- Winners: on or around Mon Dec 21, 2026

## External dependencies that must stay valid until Dec 15

| Dependency                      | Expiry / limit | Owner action | Status |
| ------------------------------- | -------------- | ------------ | ------ |
| Bryntum trial                   |                |              |        |
| Render credits                  |                |              |        |
| Gemini API key quota            |                |              |        |
| Auth0 tenant (free plan limits) |                |              |        |
| PayPal sandbox app + webhook    |                |              |        |
```

Leave expiry cells blank where unknown; later packages fill them.

## Definition of done

- [ ] All preconditions pass and are reported.
- [ ] ADR 0008 committed.
- [ ] `docs/epic5-checklist.md`, `docs/submission/DEADLINES.md` committed.
- [ ] Progress document updated.
- [ ] Full verification set passes.
- [ ] Report uses the template in 00 section 10.

## Out of scope

Any product code. Bryntum installation. Render changes.
