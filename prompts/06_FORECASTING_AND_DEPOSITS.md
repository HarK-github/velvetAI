# Epic 5 · Work Package 06 — Forecasting, Weak Slots, and Forecast-Bounded Deposits

Priority: P1 (fill bands, weak slots, no-show badge, deposit tier) · P2 (cash forecast, promote weak slot) · Time box: 1.5 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

Turn the seeded history into explainable predictions that change real behavior:

1. Fill-probability bands behind the Bryntum schedule (J.2).
2. Weak slots surfaced to the merchant (J.4 item 9).
3. Deposit tier chosen from predicted demand, inside published policy bounds, explained to the buyer (J.4 item 2).
4. No-show risk badge on bookings.
5. P2: promote a weak slot (J.4 item 10) and a 4-week cash projection.

Everything is a deterministic heuristic named `heuristic-v1`. The UI says "Heuristic forecast on demo history (v1)". Never claim machine learning, accuracy percentages, or real-world calibration.

## Preconditions

1. WP 04 VERIFIED (synthetic history exists). WP 05 read model exists.
2. Read `packages/forecasting` and list its exports. Read the existing deposit/policy logic used by `/policy` (demand/fill sliders) in `packages/domain`. Report function names. Reuse them; do not create a second deposit-tier implementation.

## All math is integer basis points (bps)

10000 bps = 100%. Use integer arithmetic only. Round with `Math.floor` after integer multiplication/division, documented per function. No floats in persisted values. (Intermediate float use inside a pure function is not allowed either; keep it integer.)

## F1. Fill probability per window

Windows: per resource, per local date (merchant zone), per local hour within opening hours (09:00–10:00, 10:00–11:00, ...).

Function (pure, in `packages/forecasting/src/fill-probability.ts`):

```ts
export function computeFillProbability(input: {
  history: Array<{ weekday: number; hour: number; offeredMinutes: number; bookedMinutes: number }>; // same resource, last 28 days, merchant-local weekday/hour
  window: { weekday: number; hour: number; startsAt: Date };
  currentBookedMinutes: number; // minutes of this future window already blocked (bookings + fixtures + holds)
  windowMinutes: number; // usually 60
  now: Date;
}): { fillProbabilityBps: number; factors: Array<{ code: string; label: string; bps: number }> };
```

Algorithm:

1. **base** (historical, Laplace-smoothed): over history rows with the same weekday and hour, `B = sum(bookedMinutes)`, `O = sum(offeredMinutes)`. `base = floor(10000 * (B + 60) / (O + 120))`. (Prior equals one booked hour out of two offered hours, so empty history gives 5000.) Factor `{ code: "HISTORY", label: "Usually N% booked on <Weekday>s at <h> <AM/PM>", bps: base }`.
2. **already booked**: `ratio = floor(10000 * currentBookedMinutes / windowMinutes)`. If `ratio >= 5000` → `+1500` factor `ALREADY_BUSY` "Already half booked". If `ratio >= 10000`, final result is 10000 (window full) with factor `FULL`.
3. **short lead time**: if window starts in less than 24 h and `ratio < 2500` → `-1500` factor `SHORT_NOTICE_EMPTY` "Starts soon and still mostly open".
4. **long lead time**: if window starts in more than 7 days → move halfway to 5000: `adj = floor((5000 - base) / 2)`; factor `FAR_AHEAD` "Far ahead; less certain".
5. Sum and clamp to [0, 10000].

Bands: `< 4000` → `WEAK` ("Likely to stay empty"), `4000–7499` → `NORMAL`, `>= 7500` → `HIGH_DEMAND` ("High demand").

Unit tests: empty history → 5000; full history → near 10000; each factor triggers at its threshold and not one minute before; clamp at 0 and 10000; DST day hours map correctly in merchant zone; deterministic output for same input.

## F2. No-show risk per booking

Pure function `computeNoShowRisk` in `packages/forecasting/src/no-show-risk.ts`:

Start at 800 bps. Add:

| Condition                                                 | bps                   | Factor label                     |
| --------------------------------------------------------- | --------------------- | -------------------------------- |
| lead time > 336 h (14 days)                               | +700                  | "Booked far in advance"          |
| lead time < 2 h                                           | +300                  | "Booked at the last minute"      |
| deposit not paid (or fixture deposit_paid=false)          | +600                  | "No deposit paid"                |
| deposit paid                                              | −400                  | "Deposit paid"                   |
| each prior NO_SHOW of same buyer key/user in last 90 days | +1500 each, max +3000 | "Missed N previous appointments" |
| local start before 09:30 or at/after 18:00                | +300                  | "Early or late slot"             |

Clamp [0, 10000]. Bands: `< 1500` LOW, `1500–2999` MEDIUM, `>= 3000` HIGH.

Buyer history uses the internal user id for real bookings and `buyer_key` for synthetic data. Never use emails or names. Never show the buyer's past no-shows to anyone except merchant/judge on `/schedule`.

Unit tests for each row and the clamp/band thresholds.

## F3. Snapshots

Migration: `forecast_snapshots` (tenant table, RLS):

```text
id                    uuid pk
tenant_id             uuid not null
resource_id           uuid not null
window_start          timestamptz not null
window_end            timestamptz not null
fill_probability_bps  integer not null CHECK (fill_probability_bps BETWEEN 0 AND 10000)
band                  text not null CHECK (band IN ('WEAK','NORMAL','HIGH_DEMAND'))
factors               jsonb not null
model_version         text not null         -- 'heuristic-v1'
inputs_sha256         text not null         -- hash of canonical JSON of inputs
computed_at           timestamptz not null default now()
UNIQUE (tenant_id, resource_id, window_start, model_version)
```

Service `ForecastService.recompute({ tenantId, from, to, now })`: reads history (synthetic_history for the judge tenant + real COMPLETED/NO_SHOW/CANCELLED bookings for any tenant), current blocking claims, computes windows for the next 7 days, upserts snapshots. Idempotent.

Triggers to recompute:

- Judge reset step `compute_forecasts` (WP 04 hook).
- `POST /v1/merchant/forecasts/recompute` (merchant, Idempotency-Key, rate limit 1/min).
- Worker job every 15 minutes for tenants with activity in the last day (P2; on-demand is enough for P1).

## F4. Wire into the schedule and weak slots

1. `GET /v1/merchant/schedule` fills `resourceTimeRanges` from snapshots in range (only WEAK and HIGH_DEMAND bands; NORMAL omitted to keep the view clean). `label` like "38% likely to fill".
2. Events get `noShowRisk` from F2.
3. `GET /v1/merchant/weak-slots?days=7` → up to 10 windows with band WEAK that still have at least one bookable slot, sorted by lowest probability, each with factors and the bookable slot times (`display` fields).
4. Scheduler UI: "Weak slots" panel listing them; clicking scrolls the scheduler to the window.

## F5. Forecast-bounded deposit

1. Find the existing deposit policy function (used by the Policy page). It takes a demand/fill input and returns a deposit tier within policy min/max. Feed it `fillProbabilityBps` from the snapshot for the slot's window. If no snapshot exists → standard tier with factor "No forecast available".
2. The quote (`quote_booking.v1` and REST quote) adds:

```json
"pricingBasis": {
  "policyVersion": "…",
  "depositTier": "HIGH_DEMAND",
  "fillProbabilityBps": 8200,
  "forecastModelVersion": "heuristic-v1",
  "forecastSnapshotId": "…",
  "explanation": "High-demand time (82% likely to fill), so the deposit is $35.00 instead of $20.00."
}
```

3. The deposit amount itself is already bound into the signed intent at prepare time. Do not change the intent schema unless the policy version is not already included; if it is not, add `policyVersion` to the intent payload, bump the intent schema version, and update the JWS tests.
4. Prepare stores `pricingBasis` with the hold/quote so the approval page (WP 02 D3) shows the explanation line.
5. Policy bounds are absolute: deposit must be between the policy's min and max for the service. Add a property test (100 random fill values) asserting bounds.
6. Transport equivalence: REST, MCP, Ask AI, WebMCP return the same `pricingBasis` for the same slot and snapshot. Extend `transport-equivalence.test.ts`.
7. Ask AI system prompt: when quoting, the assistant may explain the deposit using `pricingBasis.explanation` verbatim. It must not invent percentages.

## F6 (P2). Promote a weak slot

`POST /v1/merchant/promotions` (merchant, Idempotency-Key) body `{ resourceId, windowStart, windowEnd, depositTier: "LOW_DEMAND" }`. Creates a versioned promotion row (tenant table, RLS, audit). Effects: the quote uses the lowest allowed tier for that window and `find_available_slots.v1` sorts promoted slots first with tag "Lower deposit". Reversible with `DELETE` (soft, audited). UI: "Promote" button on the weak slot panel. Test: quote before/after promotion, bounds still respected.

## F7 (P2). 4-week cash projection

Merchant panel: for each of the next 4 weeks, expected deposits = sum over booked appointments of deposit × (1 − noShowRisk) and expected balances similarly, plus expected fill of open windows × average price. Label "Projection based on heuristic forecast". Integer minor units only.

## Manual verification

1. Run judge reset. Open /schedule: Monday-morning WEAK bands and Saturday HIGH_DEMAND bands visible.
2. Weak slots panel lists Monday morning windows with factors.
3. Ask AI: "What's the deposit for a haircut Saturday at 2 PM?" vs "Monday at 9 AM?" → different tiers with correct explanations; approval page shows the explanation.
4. A fixture with buyer-003 shows "High no-show risk".
5. (P2) Promote a Monday slot; quote drops to low tier; Ask AI lists it first.

Evidence: `docs/evidence/forecasting.md` + screenshots.

## Definition of done

- [ ] F1–F5 implemented with tests; integer-only math.
- [ ] Bands and weak slots visible on the scheduler.
- [ ] Deposit explanation consistent across all transports and on the approval page.
- [ ] Honest labels present.
- [ ] Checklist items 2 and 9 (and 10 if P2) updated.

## Cut list

Cut in this order if late: F7 → F6 → worker recompute job → long-lead-time factor. Never cut policy-bound tests or transport equivalence for `pricingBasis`.
