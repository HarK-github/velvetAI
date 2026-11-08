# Epic 5 · Work Package 05 — Bryntum Scheduler as an Operational Surface

Priority: P0 (read view + live updates + race demo) · P2 (drag to reschedule) · Time box: 2 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

Replace the simulated `/schedule` page with a real Bryntum Scheduler showing the judge tenant's providers, bookings, holds, payment states, and (after WP 06) forecast bands. A booking made through Ask AI, MCP, or the approval page appears within 5 seconds without reloading. This is J.4 item 6 and the "Best Use of Bryntum" prize surface.

Spec: `SPEC_V1_1_AMENDMENT.md` J.2 (binding): Resources = providers, Events = appointments, Assignments = links, ResourceTimeRanges = forecast bands, payment/risk state in event rendering, explicit legend, non-color indicators, drag through backend commands with rollback on 409.

## Preconditions

1. WP 04 VERIFIED (judge tenant has data).
2. Read these official Bryntum docs before coding (they are written for LLMs):
   - React quick start: https://bryntum.com/products/scheduler/docs-llm/guide/Scheduler/quick-start/react.md
   - Public npm trial access: https://bryntum.com/products/scheduler/docs-llm/guide/Scheduler/npm/repository/public-repository-access.md
   - ResourceTimeRanges feature: https://bryntum.com/products/scheduler/docs-llm/api/Scheduler/feature/ResourceTimeRanges.md
     If a URL fails, find the current equivalent from https://bryntum.com/products/scheduler/docs/ and report the URL you used.

## Step 1 — Install (exact)

Check the current trial version Bryntum documents. If it is still 7.3.7:

```zsh
pnpm --filter @velvetai/web add --save-exact \
  @bryntum/scheduler@npm:@bryntum/scheduler-trial@7.3.7 \
  @bryntum/scheduler-react@7.3.7
```

If newer, use the newer version for BOTH packages. Both must match exactly. No caret.

Verify:

```zsh
pnpm --filter @velvetai/web list @bryntum/scheduler @bryntum/scheduler-react
ls node_modules/@bryntum/scheduler/*.css        # find the real CSS file names for this version
```

Rules: do not hide or remove the trial watermark; do not copy Bryntum source into the repo; do not configure a private registry; add `THIRD_PARTY_NOTICES.md` (text in `docs/setup/bryntum-render-setup.md` section 6).

Import the CSS exactly as the React quick start for this version says. Use the file names you found with `ls`, not names from memory. Pick a dark theme that matches velvetAI's dark luxury styling if one is shipped; otherwise the default theme plus a small override stylesheet `apps/web/src/styles/bryntum-overrides.css` (colors/fonts only).

Check the production build size: run `pnpm --filter @velvetai/web build` and report the size of the chunk containing Bryntum. Load the scheduler page with `React.lazy` so the home page does not download Bryntum.

## Step 2 — Backend read model

### Route

```text
GET /v1/merchant/schedule?from=<ISO UTC>&to=<ISO UTC>
Auth: Auth0 user with merchant:schedule (or judge) in the tenant
Max range: 14 days (400 if larger)
Headers: supports If-None-Match with ETag = scheduleRevision + forecast model version
```

### Contract (`packages/contracts/src/schedule.ts`)

```ts
type ScheduleResponse = {
  tenantTimeZone: string; // IANA, e.g. "America/New_York"
  scheduleRevision: string;
  generatedAt: string; // ISO UTC
  resources: Array<{
    id: string;
    name: string; // "Marco (Barber)"
    kind: "STAFF" | "ROOM";
    timeZone: string;
  }>;
  events: Array<{
    id: string; // opaque; prefix "bk_" for bookings, "hold_" for holds, "fx_" for fixtures
    resourceId: string;
    startsAt: string; // ISO UTC
    endsAt: string;
    display: { localStart: string; localEnd: string; timeZoneLabel: string };
    serviceName: string;
    kind: "BOOKING" | "HOLD" | "DEMO_FIXTURE";
    status: string; // exact booking state name, or "HELD" for holds, or fixture display_status
    paymentState:
      | "NONE"
      | "AWAITING_PAYER"
      | "VERIFYING"
      | "PAID"
      | "FAILED"
      | "REFUNDED"
      | "PARTIALLY_REFUNDED";
    holdExpiresAt?: string; // only for holds
    buyerLabel: string; // masked: "Guest A.K." or fixture "Demo guest 07"; never email
    preparedBy?: "ASK_AI" | "MCP" | "WEB" | "MERCHANT";
    noShowRisk?: { band: "LOW" | "MEDIUM" | "HIGH"; bps: number }; // WP 06
  }>;
  resourceTimeRanges: Array<{
    // WP 06 fills; empty array until then
    id: string;
    resourceId: string;
    startsAt: string;
    endsAt: string;
    fillProbabilityBps: number; // 0..10000
    band: "WEAK" | "NORMAL" | "HIGH_DEMAND";
    label: string; // "38% likely to fill"
  }>;
};
```

Mapping rules:

- Include bookings whose claim is blocking or whose status is terminal but inside the range (COMPLETED, NO_SHOW, CANCELLED shown faded).
- Include active holds (blocking claims without a booking) as `kind: "HOLD"`.
- Include `demo_schedule_fixtures` as `kind: "DEMO_FIXTURE"`.
- `paymentState` mapping: derive from payment intent/capture/refund state. Put the mapping in one pure function `toSchedulePaymentState()` with a unit test per input state.
- Never include customer notes, emails, phone numbers, PayPal payer info, tokens, or raw IDs from other tables beyond the opaque event id.
- All reads in one `withTenantTransaction`.

### Tests

- Contract test: response validates against the schema.
- Booking, hold, and fixture each map correctly.
- Range > 14 days → 400. Missing scope → 403.
- Cross-tenant: a dev-tenant booking never appears in the judge-tenant response.
- ETag: same data → 304 on If-None-Match.
- No PII: serialize response, assert no `@` character in any `buyerLabel` and no `note` key anywhere.

## Step 3 — Frontend scheduler page

File: `apps/web/src/pages/SchedulePage.tsx` (replace simulated content; keep the old simulation only if it is reused by the race demo below).

Component outline (adapt prop names to the installed version's React docs; verify each prop exists):

```tsx
<BryntumScheduler
  readOnly // P0; drag is P2
  timeZone={schedule.tenantTimeZone} // verify the Scheduler timeZone config exists in this version; if not, convert using display fields and document
  startDate={rangeStart}
  endDate={rangeEnd}
  viewPreset="hourAndDay" // verify preset name
  rowHeight={64}
  barMargin={6}
  columns={[{ text: "Provider", field: "name", width: 200 }]}
  resources={resources}
  events={events} // map: { id, resourceId, startDate, endDate, name, cls, ...custom fields }
  resourceTimeRanges={ranges} // map: { id, resourceId, startDate, endDate, name, cls }
  resourceTimeRangesFeature
  eventRenderer={renderEvent} // return text/DomConfig only; no HTML strings from data
/>
```

Event rendering (each event shows icon + text, not only color):

| Kind / state           | Visual                         | Text line 1                         | Text line 2 |
| ---------------------- | ------------------------------ | ----------------------------------- | ----------- |
| HOLD                   | dashed border                  | "Hold · 4:12 left" (live countdown) | service     |
| BOOKING awaiting payer | amber border                   | "Awaiting deposit"                  | service     |
| BOOKING verifying      | amber pulse                    | "Verifying payment"                 | service     |
| BOOKING paid/confirmed | solid                          | "Confirmed · Deposit paid"          | service     |
| CHECKED_IN             | solid + check icon             | "Checked in"                        | service     |
| COMPLETED              | faded                          | "Completed"                         | service     |
| NO_SHOW                | faded + warning icon           | "No-show"                           | service     |
| CANCELLED              | faded + strike                 | "Cancelled"                         | service     |
| DEMO_FIXTURE           | dotted underline label         | "Demo booking" + status             | service     |
| noShowRisk HIGH        | small "High no-show risk" tag  |                                     |             |
| preparedBy ASK_AI/MCP  | small "via AI" / "via MCP" tag |                                     |             |

Resource time ranges (after WP 06): WEAK = subtle cool stripe with label "Likely to stay empty", HIGH_DEMAND = subtle warm stripe "High demand". Ranges render behind events.

Legend: a visible legend panel above the scheduler explaining every style above, readable by screen readers (a `<ul>` with text, not just swatches).

Toolbar: date navigation (Today, previous/next day, week view toggle), provider filter, "Show forecast bands" toggle, last updated time ("Updated 3 s ago"), and a status pill when polling fails ("Live updates paused — retrying").

Event click → side panel with: service, time (merchant zone + "Your time"), status, payment state, preparedBy, no-show risk with its factors (WP 06), and for judges a link "Open technical proof" (WP 08).

### Live updates

- Poll `GET /v1/merchant/schedule` every 5 s with If-None-Match. On 304 do nothing.
- When data changes, update the stores without recreating the scheduler (use the store update approach recommended by Bryntum docs for frequently refreshed data, for example `syncDataOnLoad` on stores; verify the option name). Preserve scroll position and selection.
- Pause polling when the tab is hidden (`document.visibilityState`).
- Announce new bookings in an `aria-live="polite"` region: "New booking: Executive Haircut, 2:00 PM EDT, Marco."
- Hold countdowns tick locally every second and remove the hold when it hits 0 (the next poll confirms).

### Auth/tenant

The page requires sign-in with merchant or judge permissions. Unauthorized users see a friendly "Sign in as the demo merchant to view the live schedule" with a sign-in button.

## Step 4 — Live double-booking race demo (P0)

On the schedule page, a "Race test" button (judge role only) calls:

```text
POST /v1/judge/race-test
Auth: judge:abuse_lab in judge tenant, Idempotency-Key
Body: { resourceId, startsAt, serviceId, parallel: 20 }   (parallel 2..50)
```

Server: runs `parallel` concurrent hold attempts on the same slot through the real hold service (one DB connection each, `Promise.all`), as 20 different synthetic buyer principals in the judge tenant. Returns `{ attempts: 20, succeeded: 1, conflicts: 19, winnerHoldId, durationMs }`. Then immediately releases the winner hold through the normal release path so the demo leaves no residue.

UI shows the result as "20 simultaneous attempts → 1 hold, 19 rejected by the database" and the winning hold flashes on the scheduler before release.

Tests: exactly 1 success under 20 and 50 parallel; non-judge tenant → 403; slot with an existing booking → 0 successes, 20 conflicts.

## Step 5 — Drag to reschedule (P2, only if all P0 green before Nov 4)

```text
POST /v1/bookings/:id/reschedule
Auth: merchant:schedule, Idempotency-Key
Body: { newResourceId, newStartsAt, expectedScheduleRevision }
```

Atomic in one tenant transaction: insert new blocking claim (GiST decides), release old claim, update booking times, append audit + outbox event. Payment untouched. 409 on GiST conflict or revision mismatch.

UI: enable drag only for paid confirmed bookings and only for merchant role. Use Bryntum's async drop finalize pattern (verify in docs: `beforeEventDropFinalize` with `context.async = true` and `context.finalize(ok)`). On 409, finalize(false) so the event snaps back, and show the conflict reason.

## Manual verification

1. Sign in as judge on local stack. Open /schedule. Screenshot the week view with legend.
2. In another tab, book through Ask AI → approval page → PayPal. Watch the event appear on the scheduler within 5 s (hold dashed → awaiting deposit → confirmed). Record a short screen capture or 3 screenshots.
3. Run the race test. Screenshot the result.
4. Keyboard-only: tab to the scheduler, move between events, open the side panel.
5. Repeat 1–3 on the hosted site.

Evidence: `docs/evidence/bryntum-scheduler.md` with screenshots in `docs/evidence/bryntum/`.

## Definition of done

- [ ] Packages installed exactly; THIRD_PARTY_NOTICES.md present; watermark untouched.
- [ ] Read model route + tests.
- [ ] Scheduler renders all states with icon + text and legend.
- [ ] Live updates within 5 s without scheduler re-creation.
- [ ] Race demo endpoint + tests + UI.
- [ ] Lazy-loaded; bundle size reported.
- [ ] Checklist items 6 and J.2 updated.

## Cut list

Never cut the read model, live updates, legend, or race demo. You may cut: week view (keep day view), provider filter, the side panel's factor list (keep basic info), drag to reschedule (P2).
