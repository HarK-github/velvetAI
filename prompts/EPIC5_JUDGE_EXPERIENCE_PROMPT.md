# velvetAI Epic 5 Judge Experience Prompt

Use only after `prompts/EPIC4_CLOSEOUT.md` reports Epic 4 ACCEPTED.

```text
Act as the velvetAI Epic 5 Lead Engineer, release manager, and hackathon demo producer.

CURRENT PHASE

Sprint Epic 5 — Winning Judge Experience, Hosted Deployment, and Submission

Deadline facts:
- Devpost submission deadline: November 12, 2026 (confirm the exact time and time zone on Devpost and record it in docs/submission/DEADLINES.md).
- Internal submission target: November 10, 2026 (two-day buffer).
- Feature freeze: November 6, 2026. After freeze, only bug fixes, copy, accessibility, and demo polish.
- Judging: December 1–15, 2026. The hosted demo, Auth0 tenant, PayPal Sandbox app, Gemini key, and Bryntum trial must all remain valid through December 15.

Priority rules:
- P0 must ship. P1 ships if P0 is green. P2 only if time remains before freeze.
- Never start a P1 item while any P0 item is red.
- Deploy early. A working hosted P0 beats a local P1.

READ FIRST

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md (Section J — Judge Mode and Demo Requirements is binding)
3. @docs/implementation-progress.md
4. @docs/EPIC4_WEBSITE_STATUS.md
5. @docs/evidence/mcp-external-client.md
6. @docs/setup/bryntum-render-setup.md
7. @docs/DEPLOYMENT.md and @render.yaml
8. @docs/runbooks/paypal-sandbox-e2e.md
9. packages/forecasting, apps/abuse-lab, apps/web/src/pages, apps/web/src/components

NON-NEGOTIABLE INVARIANTS (unchanged from Epics 2–4)

- GiST exclusion on resource_claims remains the only double-booking authority.
- Every new tenant table has FORCE ROW LEVEL SECURITY with transaction-local app.tenant_id.
- Every new mutating route requires Idempotency-Key.
- Money is bigint minor units internally and canonical decimal strings on the wire.
- AI callers can never commit. Raw confirmation tokens never reach a model, a URL, or a log.
- Booking confirmation depends only on PayPal capture status COMPLETED.
- PayPal stays sandbox-only. Live credentials are rejected at startup.
- Judge-only features (reset, fault injection) operate only on the dedicated judge tenant and fail closed elsewhere.
- No secrets in source, render.yaml, logs, traces, screenshots, or the video.
- Honest labeling: anything simulated, heuristic, or CI-only must be labeled as such in the UI.

==================================================
W0 — BASELINE AND PLAN (P0, half day)
==================================================

1. Confirm Epic 4 ACCEPTED commit SHA and clean baseline (format, lint, typecheck, test, build).
2. Write ADR 0008: Judge Mode, Scheduler Read Model, Forecast Snapshots, and Hosted Deployment.
3. Create docs/epic5-checklist.md mapping every Section J requirement (J.1–J.4, all 10 demo path items) to a work package below, with status.
4. Create branch feat/epic-5-judge-experience.

==================================================
W1 — BUYER APPROVAL PAGE AND GOLDEN PATH (P0)
==================================================

The approval locator currently returns a minimal JSON response. This is the heart of the agent-safety story and must be a polished buyer page.

1. Web route: /approve/:locator (web origin, not the API origin). The Ask AI approval card and MCP prepare_booking response link here.
2. The page fetches GET /v1/booking-approvals/:locator and shows: service, provider/resource display name, local date/time with time zone, duration, price, deposit, cancellation tiers, hold expiry countdown from server time, and which agent/surface prepared it ("Prepared by Ask AI" / "Prepared by MCP client <display name>").
3. Approval requires an authenticated buyer session (Auth0). Bind approval to the buyer who prepared it, or to the authenticated buyer if the agent prepared it on their behalf; Buyer B opening Buyer A's link must fail closed (amendment Section I, scenario 13). Show a clear "This approval belongs to another account" state.
4. "Approve and pay deposit" calls the existing confirm endpoint with an Idempotency-Key. The confirmation token stays server-side or in memory only; never in the URL, localStorage, or logs.
5. After approval, the same page performs commit_booking as the human session, then renders the existing PayPal JS SDK v6 button for the deposit, then shows CONFIRMED only after backend capture COMPLETED.
6. States: loading, expired hold (offer "find a new slot"), already approved, already committed, capture uncertain ("payment is being verified" with polling), payment failed, slot released.
7. Security headers: CSP frame-ancestors 'none' on this route in nginx and Vite preview config.
8. Golden path E2E (Playwright, against local stack with FakeModelProvider and PayPal mocked adapter): Ask AI "book a haircut tomorrow at 2 PM" -> approval card -> /approve page -> approve -> commit -> PayPal mocked capture -> CONFIRMED -> booking visible in schedule API.
9. Manual real-sandbox run of the same path with real Gemini and real PayPal Sandbox, evidenced in docs/evidence/golden-path-local.md.
10. Re-run `pnpm mcp:smoke`, now approving through the /approve page instead of the API-level stand-in.

==================================================
W2 — RENDER STAGING DEPLOYMENT (P0, start no later than day 3)
==================================================

1. Validate render.yaml against the current Render Blueprint spec. API web service, worker, static web site, managed PostgreSQL. No secrets in the file; use an environment group (velvetai-sandbox-secrets) and `sync: false` entries.
2. After the database exists, verify and record:
   - `SELECT version();` is PostgreSQL 17 (or document the managed version actually provisioned).
   - `btree_gist` is available and created by migrations.
   - The runtime role used by the API and worker has rolsuper = false and rolbypassrls = false. If Render does not allow creating a separate NOBYPASSRLS role, document exactly what was possible and prove FORCE RLS still applies with a cross-tenant read test executed against the hosted database.
3. Pre-deploy migrations run once per deploy. Health checks: /health/live and /health/ready.
4. Web: VITE_API_BASE_URL, VITE_AUTH0_* and VITE_PAYPAL_CLIENT_ID set at build time. SPA fallback routing works for /approve/:locator, /schedule, /security, /judge.
5. Auth0: give the user exact steps to add the Render web URL to Allowed Callback URLs, Allowed Logout URLs, and Allowed Web Origins. Add the Render web origin to the API CORS allowlist and MCP Origin/Host allowlists.
6. PayPal: register the stable webhook URL https://<api>.onrender.com/v1/webhooks/paypal/<opaque-connection-key>, set PAYPAL_WEBHOOK_ID, delete obsolete tunnel registrations, and repeat the real sandbox E2E runbook on Render. Evidence in docs/evidence/paypal-sandbox-render.md.
7. Gemini on hosted demo: add a per-user and per-IP rate limit on POST /v1/ai/chat (for example 10 turns per user per 10 minutes) and a global daily budget guard. When the quota is exhausted, show the existing quota banner. Do not silently switch to the deterministic model; if a fallback is offered, the user must click it and the badge must say "Deterministic Demo Model".
8. Cold starts: document the Render instance plan used and whether the API sleeps. If it sleeps on the chosen plan, add a judge-facing note and a warm-up request on page load of /judge.
9. Report the three public URLs (web, API health, MCP endpoint) and the deploy commit SHA.

==================================================
W3 — BRYNTUM SCHEDULER AS AN OPERATIONAL SURFACE (P0 read view, P2 drag)
==================================================

Install exactly as documented in docs/setup/bryntum-render-setup.md:

pnpm --filter @velvetai/web add --save-exact @bryntum/scheduler@npm:@bryntum/scheduler-trial@7.3.7 @bryntum/scheduler-react@7.3.7

Before installing, check Bryntum's current documented trial version. If it is newer than 7.3.7, use the newer version for BOTH packages and record why. Both packages must match exactly. No caret. Do not hide the watermark. Do not commit Bryntum source or registry tokens. Add THIRD_PARTY_NOTICES.md.

Backend read model (P0):
1. GET /v1/merchant/schedule?from=&to= (merchant:schedule scope, tenant-scoped, RLS) returns:
   - resources: providers/rooms with display name and time zone.
   - events: bookings and active holds with status, payment state (REQUIRES_PAYER_ACTION, CAPTURE_UNCERTAIN, CAPTURED/CONFIRMED, PAYMENT_FAILED, CANCELLED, NO_SHOW, COMPLETED), hold expiry, and no-show risk band (from W4). No customer notes, no PII beyond a masked display name.
   - resourceTimeRanges: fill-probability bands per resource per slot window (from W4).
   - scheduleRevision.
2. Contract in packages/contracts with canonical money and ISO UTC timestamps.

Frontend (P0):
1. Replace the UI_ONLY /schedule page with the Bryntum Scheduler (React wrapper) using Resources, Events, Assignments, and ResourceTimeRanges for forecast bands behind events.
2. Event rendering shows status and payment state with icon + text, not color alone. Explicit legend. Keyboard navigation and accessible labels.
3. Holds render as dashed with a live countdown and disappear when the reaper releases them.
4. Refresh by polling every 5 seconds with If-None-Match/scheduleRevision (or SSE if already available). A booking confirmed through Ask AI or MCP appears without a manual reload. This is demo path item 6.
5. Keep the existing "simulate concurrent double-booking race" demo, but drive it against the real API in the judge tenant: fire N parallel holds at one slot and show 1 winner, N-1 GIST conflicts, live on the scheduler.

Drag/reschedule (P2):
- POST /v1/bookings/:id/reschedule (merchant only, Idempotency-Key, expected scheduleRevision). Moves the resource claim atomically inside one tenant transaction; GiST decides conflicts. On 409 the scheduler rolls back the optimistic move and shows the conflict reason. Do not touch payments.

==================================================
W4 — FORECASTING PERSISTENCE AND UI (P1)
==================================================

Use the existing @velvetai/forecasting package. Keep it deterministic and explainable. Label it in the UI as "Heuristic forecast on synthetic history (v1)". Do not claim ML accuracy or real-world calibration.

1. Migration: forecast_snapshots (tenant_id, resource_id, window start/end, fill_probability as integer basis points, no_show_risk_bps where applicable, model_version, inputs_sha256, computed_at). FORCE RLS. Update the RLS table count everywhere it is documented.
2. Worker job (or on-demand command in judge reset) computes snapshots from PostgreSQL appointment history.
3. Fill-probability bands feed W3 ResourceTimeRanges.
4. Weak-slot surfacing (demo path item 9): GET /v1/merchant/weak-slots returns the lowest fill-probability open windows for the next 7 days with the top contributing factors.
5. Forecast-bounded deposit (demo path item 2): the quote shows which deposit tier applied and why ("high-demand window: 82% predicted fill"). The deposit must stay inside the published policy bounds, the policy version must be bound into the signed intent, and the same inputs must produce the same quote across REST, MCP, and Ask AI (extend the transport equivalence suite).
6. No-show risk badge per booking in the scheduler (Low/Medium/High with text).
7. P2: four-week cash forecast panel (expected deposits and balances), clearly labeled as projection.
8. P2: targeted action (demo path item 10): merchant clicks "Promote weak slot" -> creates a versioned promotion that lowers the deposit within policy bounds for that window and ranks it higher in find_available_slots. Audited, idempotent, reversible.

==================================================
W5 — ABUSE LAB DASHBOARD (P1)
==================================================

Route: /security.

1. Show all Abuse Lab scenarios grouped by category and severity, each with: threat description, the invariant it protects, and its last result.
2. Two honest evidence types, labeled separately:
   - "CI-verified": results from the latest full test run, exported at build time to a JSON artifact (scenario id, name, severity, pass/fail, commit SHA, timestamp). No live execution in production.
   - "Live run": a curated set of 8–12 scenarios that are safe to execute against the hosted judge tenant over real HTTP, for example: slot hoarding (parallel holds), AI commit attempt (COMMIT_NOT_PERMITTED_FOR_AI), prompt injection via customer note, confirmation replay with new idempotency key, intent A + confirmation B, duplicate JSON keys, alg:none / wrong kid JWS, cross-tenant read attempt, missing Idempotency-Key, MCP wrong protocol revision.
3. POST /v1/judge/abuse-lab/runs executes the live set only in the judge tenant, requires the judge role, is rate limited (1 run per 30 seconds per user), has a total time budget, and streams per-scenario results.
4. Each live result shows: expected outcome, observed HTTP status/error code, and "state changed: none" proof (counts of bookings, commits, captures before/after).
5. Model refusal alone is never a pass. Every pass is a deterministic server-side assertion.

==================================================
W6 — JUDGE MODE (P0 reset and proof panel, P1 fault injection)
==================================================

Amendment Section J.1 and J.3 are binding.

1. Dedicated synthetic judge tenant with a fixed ID, created by migration or seed command, never shared with the development tenant.
2. POST /v1/judge/reset (judge role, Idempotency-Key, rate limited to 1 per minute per tenant):
   - Generates a unique run ID.
   - Deletes or archives only judge-tenant operational rows that are legally mutable. Append-only financial journal rows are never deleted; scope new runs by run ID instead.
   - Seeds deterministic services, resources, availability, 4 weeks of synthetic history, current-week bookings across all states, forecast snapshots, and attack fixtures.
   - Never touches another tenant (prove with a test that a reset with a forged tenant context changes zero rows elsewhere).
   - Reports progress and failures step by step.
   - Never claims PayPal sandbox transactions were deleted. Fresh sandbox orders are created only when the judge runs the payment step.
3. Judge account: a dedicated Auth0 user with judge + buyer + merchant memberships in the judge tenant only. Credentials go into the Devpost "testing instructions" field, never into the repository.
4. /judge page: one-click reset, guided demo checklist (the 10 Section J.4 items with links), and the Technical Proof Panel (J.3): opaque booking ID, intent hash, confirmation consumed state, idempotency key hash, PayPal order and capture IDs (truncated), capture status, webhook verification state, resource-claim state, reconciliation result. No secrets, tokens, notes, or PII.
5. Fault injection (P1, demo path item 8): a judge-tenant-only toggle "Drop the next capture response". The PayPal adapter wrapper performs the real sandbox capture but discards the response; the booking becomes CAPTURE_UNCERTAIN with the claim still blocking; reconciliation or webhook converges to exactly one capture, one CONFIRMED booking, and one balanced journal entry. The proof panel shows the convergence. The toggle is impossible to enable outside the judge tenant (test it).

==================================================
W7 — SUBMISSION PACKAGE (P0, starts November 6)
==================================================

1. README rewrite for judges: one-paragraph pitch, hosted links, judge login instructions pointer, 10-step demo path, architecture diagram (Mermaid), security invariants, sponsor technology usage (PayPal Orders v2 + JS SDK v6 + webhooks + refunds; Bryntum Scheduler; Render; Auth0; Gemini), local setup in under 10 commands, license, third-party notices.
2. docs/submission/DEVPOST_SUBMISSION.md: inspiration, what it does, how we built it, challenges, accomplishments, what we learned, what's next, built-with list. Every claim must match verified evidence.
3. docs/submission/VIDEO_SCRIPT.md for a video under 3 minutes, shot list with timestamps:
   - 0:00–0:20 problem: no-shows and AI agents booking without consent.
   - 0:20–1:10 Ask AI finds a slot, shows the forecast-bounded deposit, prepares a hold; buyer approves on /approve; PayPal sandbox deposit; scheduler updates live.
   - 1:10–1:50 attacks: AI tries to commit, prompt injection, slot hoarding, replay — all blocked live in /security.
   - 1:50–2:25 dropped capture response reconciles to one payment; proof panel.
   - 2:25–2:50 weak slot surfaced by forecast and promoted; MCP client books through the same rules.
   - 2:50–3:00 close.
4. docs/submission/JUDGE_TESTING.md: exact steps, PayPal sandbox buyer instructions (credentials supplied via Devpost field, not the repo), known limitations stated honestly (sandbox only, heuristic forecast, WebMCP simulated unless verified).
5. Validity through December 15: record expiry dates for the Bryntum trial, Render credits, Gemini key quota, Auth0 tenant, and PayPal sandbox app in docs/submission/DEADLINES.md, with the renewal plan for each.

==================================================
CALENDAR
==================================================

- Oct 24: Epic 4 closeout (separate prompt).
- Oct 25–27: W0, W1.
- Oct 27–29: W2 hosted staging live with real sandbox E2E.
- Oct 29–Nov 2: W3 P0, W4.
- Nov 2–5: W6 P0, W5, W6 fault injection.
- Nov 6: feature freeze. P2 only if everything above is green.
- Nov 6–9: W7, rehearsal of the demo on the hosted site, video recording.
- Nov 10: submit. Nov 11–12: buffer only.

Report status against this calendar at the end of every work package.

==================================================
VERIFICATION PER WORK PACKAGE
==================================================

After each work package:

1. pnpm format:check, pnpm lint, pnpm typecheck, pnpm test, pnpm build, git diff --check.
2. New tests for every new route, migration (up/down/up), RLS policy, and UI state.
3. Update docs/implementation-progress.md and docs/epic5-checklist.md with evidence links.
4. Commit with a conventional message and report the SHA.

==================================================
REPORT FORMAT (per work package)
==================================================

1. Work package and priority.
2. What shipped, with file list.
3. Section J items now satisfied.
4. Tests added and command table.
5. Manual evidence (hosted or local) with sanitized output.
6. Honest gaps and anything labeled simulated/heuristic/CI-only.
7. Calendar status: on track / at risk / late, and what you will cut if at risk.

Never print secrets, tokens, raw confirmation tokens, judge credentials, or PII.
```
