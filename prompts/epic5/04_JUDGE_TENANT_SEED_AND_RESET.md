# Epic 5 · Work Package 04 — Judge Tenant, Deterministic Seed, and Reset

Priority: P0 · Time box: 1.5 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

A dedicated synthetic judge tenant with realistic, deterministic data, and a one-click reset that returns it to a known state without ever touching other tenants or deleting financial records. Later packages (Bryntum, forecasting, Abuse Lab, judge page) depend on this data.

Spec: `SPEC_V1_1_AMENDMENT.md` Section J.1 (binding).

## Preconditions

1. WP 01 VERIFIED. WP 02 API routes merged.
2. List the existing seed/catalog scripts (`scripts/manage-dev-catalog.ts`, `pnpm auth:provision-test-user`, `pnpm auth:provision-agent-client`) and the membership role/permission definitions. Report them.

## Fixed identifiers

```text
JUDGE_TENANT_ID = 01932b10-0000-7000-8000-000000000a01
JUDGE_SEED_VERSION = judge-seed-v1
```

Put both in `packages/domain/src/judge.ts` (or the closest existing constants file) and import everywhere. Never hardcode them twice.

## Data model changes (one migration)

Use the next migration number. All tables below are tenant tables with RLS copied from the latest tenant-table migration.

### 1. `judge_runs`

```text
id                uuid primary key
tenant_id         uuid not null  CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01')
seed_version      text not null
status            text not null CHECK (status IN ('RUNNING','SUCCEEDED','FAILED'))
started_at        timestamptz not null default now()
finished_at       timestamptz
requested_by      uuid not null          -- app_users.id of the judge
steps             jsonb not null default '[]'   -- [{name, status, count, ms, error?}]
summary           jsonb                  -- counts retained/removed/seeded
```

### 2. `demo_schedule_fixtures`

Fixture appointments for the current week are NOT stored in `bookings`. This keeps the invariant "a CONFIRMED booking always has a COMPLETED capture" untouched. Fixtures live in their own table and the schedule read model (WP 05) merges them in:

```text
id               uuid primary key
tenant_id        uuid not null CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01')
judge_run_id     uuid not null references judge_runs(id)
resource_id      uuid not null
service_id       uuid not null
starts_at        timestamptz not null
ends_at          timestamptz not null
display_status   text not null CHECK (display_status IN ('CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW','CANCELLED'))
buyer_key        text not null      -- pseudonymous, e.g. 'buyer-007'
deposit_paid     boolean not null   -- for no-show risk only; no money moved
claim_id         uuid null references resource_claims(id)
```

For every fixture whose `display_status` occupies time (CONFIRMED, CHECKED_IN), also insert a `resource_claims` row with `blocking = true` using the same claim-insert function real bookings use, so GiST stops real bookings from overlapping fixtures. Add a claim `source`/`kind` value `DEMO_FIXTURE` if the claims table has such a column; otherwise link through `claim_id` above. Fixture claims must satisfy `chk_resource_claim_blocking_state` like any other claim (read the constraint and follow it).

The UI labels fixtures "Demo booking (no payment)". They never have payment rows.

### 3. `synthetic_history`

Past appointment outcomes used by forecasting (judge tenant only; deletable):

```text
id               uuid primary key
tenant_id        uuid not null CHECK (tenant_id = judge tenant literal)
judge_run_id     uuid not null references judge_runs(id)
resource_id      uuid not null
service_id       uuid not null
starts_at        timestamptz not null
ends_at          timestamptz not null
outcome          text not null CHECK (outcome IN ('ATTENDED','NO_SHOW','CANCELLED_LATE','CANCELLED_EARLY'))
lead_time_hours  integer not null CHECK (lead_time_hours >= 0)
deposit_paid     boolean not null
buyer_key        text not null     -- opaque pseudonymous key like 'buyer-017', never PII
```

### 4. Roles

Add a `judge` role (or permissions on an existing role, following how roles are defined) with permissions:

```text
judge:reset  judge:abuse_lab  judge:fault_injection  judge:proof
```

The judge Auth0 user gets memberships in the JUDGE tenant only, with roles: buyer + merchant (or scheduler) + judge. Never in the development tenant.

## Deterministic seed (pure function + writer)

### Generator (pure, unit-tested)

`packages/application/src/judge/seed-plan.ts`:

```ts
export function buildJudgeSeedPlan(input: {
  now: Date; // injected clock
  timeZone: string; // merchant IANA zone, e.g. "America/New_York"
  seed: string; // JUDGE_SEED_VERSION
}): JudgeSeedPlan;
```

Use a seeded PRNG (implement mulberry32 or use an existing dependency if present; no Math.random) so the same `seed` + same local date produces the same plan.

Plan contents:

1. **Merchant:** "Velvet Studio" with time zone `America/New_York` (keep consistent with the dev tenant's zone if different; report).
2. **Resources (4):** "Aria (Stylist)", "Marco (Barber)", "Lena (Therapist)", "Studio A (Room)". Opening hours Mon–Sat 09:00–19:00 local, Sunday closed. 15-minute buffer after each appointment if the availability model supports buffers.
3. **Services (5)** with canonical money (USD): the 3 existing canonical services ($75 / $20 deposit, $120 / $35, $160 / $50) plus "Express Beard Trim" (30 min, $35, deposit $10) and "Color & Gloss" (90 min, $140, deposit $40). Map each service to the resources that can perform it.
4. **Synthetic history (past 28 days):** for each resource and open day, fill rate by pattern:
   - Weekday mornings 09–12: 45% booked
   - Weekday 12–17: 70%
   - Weekday 17–19: 90%
   - Saturday all day: 85%
   - Monday 09–12: 25% (this creates obvious weak slots)
     Outcomes for booked slots: 88% ATTENDED, 7% NO_SHOW, 5% CANCELLED_LATE. Higher no-show (15%) when `lead_time_hours > 336` or `deposit_paid = false`. 20 pseudonymous buyer keys; buyers 'buyer-003' and 'buyer-011' have repeated no-shows.
5. **Current and next 7 days (fixtures):** about 55% of open time booked following the same pattern, leaving clear gaps on Monday morning and Tuesday 09–11. Include at least: one booking per state that the UI must show (CONFIRMED fixture, CHECKED_IN today, COMPLETED earlier today, NO_SHOW earlier today, CANCELLED). No fixture overlaps another on the same resource.
6. **Holds:** none at seed time (holds are created live during the demo).

Unit tests (`seed-plan.test.ts`): same inputs → deep-equal plan; no overlapping fixtures per resource; all fixture times inside opening hours in the merchant zone; DST-day input still valid; at least 3 weak windows exist on Monday morning.

### Writer

`packages/application/src/judge/judge-reset-service.ts` with `resetJudgeTenant({ requestedBy, now })`.

Every DB operation runs in `withTenantTransaction(JUDGE_TENANT_ID, ...)`. The service throws immediately if called with any other tenant (defense in depth).

Steps (each recorded in `judge_runs.steps` with counts and duration):

1. **start**: insert `judge_runs` row RUNNING. If another run is RUNNING and started < 5 minutes ago → 409 `JUDGE_RESET_IN_PROGRESS`.
2. **expire_live_holds**: for judge-tenant holds still active, run the existing expiry/release path (the same code the hold reaper uses) so claims become non-blocking through normal logic.
3. **cancel_unpaid_live_bookings**: judge-tenant non-fixture bookings with no capture (for example COMMITTING, REQUIRES_PAYER_ACTION, PAYMENT_WINDOW_EXPIRED) → release through existing domain transitions with reason `JUDGE_RESET`.
4. **retain_paid_bookings**: judge-tenant bookings with any capture are NOT deleted or modified. Count them and record their time ranges. Their claims stay blocking.
5. **remove_fixtures**: delete `demo_schedule_fixtures` rows and their fixture claims, `synthetic_history`, and `forecast_snapshots` (WP 06) for the judge tenant. Never DELETE from journal, capture, refund, provider event, payment intent, or audit tables.
6. **upsert_catalog**: upsert merchant, resources, services, versions, availability rules from the plan (idempotent by deterministic ids: derive UUIDs from `uuidv5(name, JUDGE_NAMESPACE)` or an equivalent deterministic scheme already in the repo).
7. **seed_history**: insert synthetic history.
8. **seed_fixtures**: insert fixtures. If a fixture overlaps a retained paid booking (GiST conflict 23P01), skip that fixture and count it as `skipped_conflict`. Do not catch any other error type.
9. **compute_forecasts**: call the WP 06 recompute function if it exists (feature-detect; skip with status `SKIPPED_NOT_AVAILABLE` until WP 06).
10. **finish**: SUCCEEDED with summary `{ retainedPaidBookings, removedFixtures, seededFixtures, skippedConflicts, seededHistory, forecastsComputed }`. On error: FAILED with the safe error code, and the transaction for the failing step rolls back.

Wording rule: the summary and UI must never say PayPal transactions were deleted. Use "N paid sandbox bookings kept (payments can't be deleted)".

## API

```text
POST /v1/judge/reset
Auth: Auth0 user token with judge:reset in the JUDGE tenant
Headers: Idempotency-Key
Rate limit: 1 per 60 s per tenant (429 with Retry-After)
Response 202: { runId, status: "RUNNING", statusUrl: "/v1/judge/runs/<runId>" }

GET /v1/judge/runs/:runId   -> { runId, status, steps[], summary }
GET /v1/judge/runs/latest   -> same for latest
```

Run the reset in-process asynchronously after responding 202 (or synchronously if it reliably finishes < 10 s; measure and report). If async, make sure a crash leaves the run FAILED-able: a run RUNNING for > 5 minutes is treated as stale and may be replaced.

Add to the idempotency plugin route list.

## Provisioning commands

1. `pnpm judge:provision` — creates the judge tenant row, merchant, and runs the first reset with `requestedBy` = a system user. Refuses unless `ALLOW_JUDGE_PROVISION=1`. Works locally and against Render (user runs it from their Mac with the hosted migration URL in env; document exactly).
2. `pnpm auth:provision-judge-user` — given an Auth0 user `sub` (passed as an argument, printed by the user from Auth0 dashboard → User Management → Users → the judge user → user_id), creates `app_users` + judge-tenant memberships (buyer, merchant/scheduler, judge). Never adds dev-tenant membership.

Give the user exact Auth0 steps to create the judge user:

1. Auth0 Dashboard → User Management → Users → Create User.
2. Email: a mailbox the team controls (for example a plus-address of the team email). Connection: Username-Password-Authentication. Password: strong, stored in the team password manager.
3. Open the user → copy `user_id` (looks like `auth0|...`).
4. Run `pnpm auth:provision-judge-user --sub "<user_id>"` locally (and later against hosted).

These credentials go only into the Devpost "testing instructions" field at submission. Never in the repo.

## Tests (required)

1. Reset with a forced dev-tenant id (call the service with tenant override) throws before any query.
2. RLS proof: run reset, then count rows in the development tenant for every table touched → unchanged (snapshot counts before/after).
3. Paid judge booking (create via test PayPal mock: captured) survives reset unchanged; its journal rows unchanged; summary.retainedPaidBookings = 1.
4. Fixture overlapping a retained paid booking is skipped and counted.
5. Two resets with the same clock produce identical fixture sets (compare normalized rows).
6. Concurrent reset → second gets 409 `JUDGE_RESET_IN_PROGRESS`.
7. User without `judge:reset` → 403. M2M token → 403. No token → 401.
8. CHECK constraints: inserting `judge_runs`, `synthetic_history`, or `demo_schedule_fixtures` rows with the dev tenant id fails with a check violation.
9. A real booking attempt overlapping a CONFIRMED fixture fails with the normal slot-conflict error (GiST), proving fixtures block like real bookings.
10. Rate limit: second reset within 60 s → 429.
11. Migration up/down/up.

## Manual verification

1. `pnpm judge:provision` locally. Report the summary JSON.
2. Create the Auth0 judge user, provision memberships, sign in as judge locally, open Ask AI in the judge tenant, list services (5 services), find slots Monday morning (many open).
3. Complete one real sandbox payment as judge, run reset, confirm the paid booking is kept and reported.
4. Repeat provisioning against Render (after WP 03) and report.

## Definition of done

- [ ] Migration, seed plan, reset service, routes, provisioning commands, tests pass.
- [ ] Judge user exists and works locally (and on Render if WP 03 done).
- [ ] ADR 0008 addendum documents the `demo_schedule_fixtures` design.
- [ ] Checklist J.1 updated.

## Cut list

Never cut isolation tests, CHECK constraints, or the "paid bookings retained" rule. You may simplify history patterns (fewer rules) if time is short, as long as Monday-morning weak slots still exist.
