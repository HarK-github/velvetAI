# velvetAI UX & Frontend Technical Audit — 2026-11-10

## 0. Top 10 issues for a judge demo (ranked)

| #   | Issue                                                                                                                                                                    | Where (file:line)                                                                                                                                                 | User impact                                                                                                                                                                                                 | Suggested fix (1–2 lines)                                                                                                                                                                                                    | Effort S/M/L |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | `Open approval page` triggers full page reload, wiping Ask AI chat state                                                                                                 | `apps/web/src/components/AskAIDrawer.tsx:660`, `apps/web/src/components/AskAIDrawer.tsx:1427`                                                                     | Navigating from Ask AI to `/approve/:locator` reloads the app; pressing Back or reopening Ask AI loses the entire conversation.                                                                             | Replace `<a href={approvalUrl}>` and `window.location.href` with SPA `navigate(\`/approve/${cleanLocator}\`)`, and persist chat in Context + `sessionStorage`.                                                               | S            |
| 2   | Clicking multiple time chips appends duplicate QuoteCards; holding a new time leaves old DB holds dangling                                                               | `apps/web/src/components/AskAIDrawer.tsx:1264-1314`, `apps/web/src/components/AskAIDrawer.tsx:1332-1391`, `packages/application/src/booking-service.ts:1590-1710` | Clicking 3 slots fills chat with 3 live QuoteCards; clicking "Hold this time" twice duplicates ApprovalCards; switching times leaks active 15m holds.                                                       | Maintain a single active slot/quote selection in drawer state (replacing instead of appending), disable "Hold this time" once held, and release prior `HELD` booking via `/prepare-cancellation` + `/cancel` when replacing. | M            |
| 3   | Missing CSS utility classes & tokens (`--text-dim`, `--text-body`, `.spinner`, `.button--primary/secondary/outline/ghost`, `.text-muted`, `.signal-dot--red/gold/amber`) | `apps/web/src/pages/ApprovalPage.tsx:382-383,452-453,473,552,572,1018`, `apps/web/src/components/AskAIDrawer.tsx:531-550`                                         | Spinners on `/approve` render invisible (0px); QuoteCard dark buttons lack contrast borders; dimmed copy loses visual hierarchy (`--text-dim`/`--text-body` undefined).                                     | Define missing `.spinner`, `.text-muted`, `--text-dim`, `--text-body`, `.button--*`, and `.signal-dot--*` rules in `apps/web/src/index.css`.                                                                                 | S            |
| 4   | `GET /v1/booking-approvals/:locator` fires up to 4 times on mount and `/approve` renders contradictory/duplicated copy on 404/error                                      | `apps/web/src/pages/ApprovalPage.tsx:74-127`, `apps/web/src/pages/ApprovalPage.tsx:351-352,415-430`                                                               | Flickers/repeats approval fetches on StrictMode + Auth0 settle; shows `"Prepared by Ask AI"` and `"Your AI assistant reserved this time for you."` (twice) even on `"not found"`/error.                     | Fetch approval details once per `locator` with ref/effect split from Auth0 state; hide AI attribution hero copy when `!details \|\| pageState === "error"`.                                                                  | S            |
| 5   | `ApprovalPage` lacks `CAPTURE_UNCERTAIN` UI, `onCancel` handling, `onPaymentExpired` wiring, and `/v1/operations/:id` polling                                            | `apps/web/src/pages/ApprovalPage.tsx:258-266,809-818`, `apps/web/src/components/PayPalButton.tsx:273-290`                                                         | If network/PayPal capture returns `202 UNCERTAIN`, UI falsely says `"Payment capture was unsuccessful"` without polling `/v1/operations/:id`; expiry/cancel inside PayPal flow leaves ambiguous top banner. | Handle `CAPTURE_UNCERTAIN` with polling to `apiClient.getOperation()`, pass `onCancel` + `onPaymentExpired` from `ApprovalPage` to `PayPalButton`, and wire `verifying_payment`.                                             | M            |
| 6   | Mobile nav (`<= 980px`) hides `.nav-links` with no menu and overflows 390px when signed in                                                                               | `apps/web/src/index.css:1055-1058`, `apps/web/src/components/Navbar.tsx:323-429`                                                                                  | On 390px viewports `/schedule`, `/policy`, and `/status` links disappear completely while `API + Ask AI + User + Logout + Book Now` crowd/overflow a 58px bar.                                              | Add a mobile menu toggle for `.nav-links` below `980px` and allow wrapping or compact drawer items under `480px`.                                                                                                            | M            |
| 7   | `Approve only` (MCP flow) routes to `"already_done"` claiming `"This booking has already been confirmed"`                                                                | `apps/web/src/pages/ApprovalPage.tsx:232-240,632-637`                                                                                                             | Buyer clicks `"Approve only (let my assistant finish)"` and is told the booking is already confirmed before agent commit or deposit payment happens.                                                        | Add a dedicated `"approved_awaiting_agent"` state explaining approval was granted and the assistant can now commit, distinct from `"already_done"`/`"confirmed"`.                                                            | S            |
| 8   | `/book` fails on initial signed-out load (`quote` auto-fires 401), `/schedule` shows hardcoded mock data, and `/security` 404-falls back to `/`                          | `apps/web/src/components/BookingSimulatorSection.tsx:244-299`, `apps/web/src/pages/SchedulePage.tsx:16-65,140-148`, `apps/web/src/App.tsx:86-104`                 | Opening `/book` signed out immediately flashes red Auth error below quote console; `/schedule` never shows real DB/confirmed bookings and fakes "Release Hold" locally.                                     | Guard auto-quote when signed out behind a sign-in prompt, load public masked schedule from API on `/schedule`, and add 404/fallback handling plus `/security` route if required by 04A.                                      | M            |
| 9   | Signed-out Ask AI UX shows interactive prompt pills + Retry error instead of sign-in prompt, and logout does not clear chat/keys                                         | `apps/web/src/components/AskAIDrawer.tsx:1189-1262,1578-1603`, `apps/web/src/components/Navbar.tsx:247-253`                                                       | Signed-out visitor sees unactionable quick pills then `"Concierge Alert"` + `"Retry"`; logging out leaves previous user's messages and cached idempotency keys in memory.                                   | Render explicit sign-in CTA inside `AskAIDrawer` when `!isAuthenticated`; call `setMessages([])` and `apiClient.resetActionKeys()` on logout.                                                                                | S            |
| 10  | Missing `favicon` (404), static single `<title>`, large 1.36 MB eager JS bundle, and developer jargon across public pages                                                | `apps/web/index.html:6-16`, `apps/web/dist/assets/index-D_tuABNe.js`, `apps/web/src/components/BookingSimulatorSection.tsx:363,511,763`                           | Every page load 404s on `/favicon.ico`, downloads 1,360.09 kB upfront, never updates tab titles per route, and dumps raw JWS/GiST/ledger text on `/book`.                                                   | Add SVG/ICO favicon + per-route `document.title` + `React.lazy` per page/drawer, and move JWS/GiST diagnostics behind a collapsible developer inspector.                                                                     | M            |

---

## 1. Inventory

### 1.1 Routes (`apps/web/src/App.tsx:86-104`, `apps/web/src/router.tsx:23-58`)

Routing uses a custom `RouterContext` + `window.history.pushState` / `popstate` listener in `apps/web/src/router.tsx:12-58` and renders pages in `AppContent.renderCurrentPage` (`apps/web/src/App.tsx:86-104`):

- `/` -> `<HomePage />` (`App.tsx:100-103`)
- `/book` -> `<BookingPage />` (`App.tsx:92-93`)
- `/schedule` -> `<SchedulePage />` (`App.tsx:94-95`)
- `/policy` -> `<PolicyPage />` (`App.tsx:96-97`)
- `/status` -> `<StatusPage />` (`App.tsx:98-99`)
- `/approve/:locator` (`currentPath.startsWith("/approve/")`) -> `<ApprovalPage locator={locator} />` (`App.tsx:87-90`)
- Any unmatched path (including `/security`) -> falls through `default:` silently to `<HomePage />` (`App.tsx:100-103`).

### 1.2 Components (`apps/web/src/components`) & Pages (`apps/web/src/pages`)

**Components:**

- `AskAIDrawer.tsx`: Slide-over AI concierge drawer wrapping `@ai-sdk/react` `useChat`, direct slot quote/prepare buttons, follow-up chips, and sub-cards (`ToolStepChip`, `ServiceListCard`, `SlotsCard`, `QuoteCard`, `ApprovalCard`, `BookingStatusCard`, `CancellationCard`, `ToolErrorCard`).
- `BookingSimulatorSection.tsx`: Interactive booking simulator (catalog cards, slot grid, live risk/deposit quote, hold lock with JWS display, and `PayPalButton`) used on `/book`.
- `CommitSection.tsx`: Closing CTA band and footer strip rendered at the bottom of `/`.
- `ComputedProofSection.tsx`: Deterministic SVG chart computing RMS drift ratio across 720 samples on `/`.
- `EdgeMeta.tsx`: Fixed decorative edge labels displaying build text and scroll percentage.
- `ErrorBoundary.tsx`: Top-level React class error boundary showing fallback UI with Reload button and dev-only stack details.
- `GeometrySection.tsx`: Temporal scale SVG diagram showing 300s hold and 120s confirmation windows on `/`.
- `HeroSection.tsx`: Landing hero with machined dial SVG and in-page hash CTAs (`#protocol`, `#proof`, `#simulator`) on `/`.
- `Navbar.tsx`: Fixed top navigation bar with route links, API latency badge, Ask AI drawer button, Auth0 login/logout/status badge, and Book Now CTA.
- `PayPalButton.tsx`: PayPal v6 JS SDK (`paypal.com/web-sdk/v6/core`) + fallback deposit checkout component creating orders, running a window countdown, and capturing deposits.
- `ProtocolSection.tsx`: Architectural protocol summary list (`REST`, `MCP`, `WebMCP`, `Ask AI`) on `/`.
- `RuntimePolicySection.tsx`: Interactive risk-tier selector repainting CSS custom properties and calling `POST /v1/risk/evaluate`.
- `SafeMarkdown.tsx`: XSS-hardened `react-markdown` wrapper rejecting `javascript:`, `vbscript:`, and `data:` link schemes.
- `StateRotorSection.tsx`: Scroll-driven sticky rotating state dial showcase on `/`.
- `UIStates.tsx`: Shared `LoadingState`, `EmptyState`, `ValidationErrorState`, `ForbiddenState`, and `DependencyErrorState` components (unused by current pages).

**Pages:**

- `HomePage.tsx`: Main `/` landing page combining `HeroSection`, 4 route navigation cards, `ProtocolSection`, `ComputedProofSection`, `GeometrySection`, `StateRotorSection`, and `CommitSection`.
- `BookingPage.tsx`: Wrapper page for `/book` rendering a page header and `<BookingSimulatorSection />`.
- `SchedulePage.tsx`: `/schedule` operations view using static `INITIAL_SCHEDULE` state, client-only hold release, and a dual parallel `createBookingHold` race button.
- `PolicyPage.tsx`: `/policy` wrapper rendering a page header and `<RuntimePolicySection />`.
- `StatusPage.tsx`: `/status` live health and endpoint inspector polling `/health/live`, `/health/ready`, `/v1/services`, and `/v1/availability`.
- `ApprovalPage.tsx`: `/approve/:locator` human buyer review, terms checkbox, approve/commit, and PayPal deposit payment page.

### 1.3 State Management

- **Ask AI conversation & drawer open state**: `isAiOpen` boolean lives in `AppContent` local state (`apps/web/src/App.tsx:28`). Conversation `messages`, `status`, `error` (`useChat` at `apps/web/src/components/AskAIDrawer.tsx:1164-1166`), `inputVal`, `providerStatus`, `isQuotingSlot`, and `isHoldingSlot` (`AskAIDrawer.tsx:1075-1079`) live purely in component memory inside `AskAIDrawerInner` (no React context, no `localStorage`/`sessionStorage`).
- **Auth state**: Managed by `<Auth0Provider useRefreshTokens={true} cacheLocation="localstorage">` (`apps/web/src/App.tsx:202-216`) storing Auth0 tokens in `localStorage`, mirrored into the mutable module singleton `apiClient` (`apps/web/src/api-client.ts:98-125,584`) by `Navbar.tsx:43-61`, `AskAIDrawer.tsx:1921-1922`, and `ApprovalPage.tsx:184-188`.
- **Approval & payment state**: Managed strictly via local `useState` and `useRef` inside `ApprovalPage.tsx:40-54` (`details`, `serverTimeOffset`, `pageState`, `errorMessage`, `agreedToTerms`, `confirmedBookingId`, `paymentOrderKeys`, `approveCommitKeyRef`, `captureKeysRef`) and `PayPalButton.tsx:100-118` (`paymentExpiresAt`, `countdownSeconds`, `isProcessing`, `error`, `sdkReady`, `sessionRef`, `paymentIntentIdRef`, `paypalOrderIdRef`, `inFlightOrderRef`).
- **Navigation state**: Custom React context `RouterContext` backed by browser `history` API (`apps/web/src/router.tsx:12-58`).

---

## 2. Ask AI findings (`apps/web/src/components/AskAIDrawer.tsx`)

### 2.1 Conversation Persistence Across Close/Reopen, Route Changes, and Logout

- **Current behavior**:
  - `AskAIDrawer` is mounted alongside `<main>` in `AppContent` (`apps/web/src/App.tsx:137`), and `AskAIDrawerInner` returns `null` when `!isOpen` (`apps/web/src/components/AskAIDrawer.tsx:1513`). Therefore, toggling the drawer or navigating via `<Link>` keeps `useChat` alive in memory during a single SPA session.
  - **However**, clicking `"Open approval page"` inside `<ApprovalCard>` (`AskAIDrawer.tsx:660-666`: `<a href={approvalUrl} target="_self">`) or via follow-up chip (`AskAIDrawer.tsx:1427`: `window.location.href = targetUrl`), reloading the browser, or completing an Auth0 redirect performs a full page reload and **wipes all chat history**.
  - On logout (`Navbar.tsx:247-253` + `AskAIDrawer.tsx:1189-1195`), `AskAIDrawerInner` calls `stop()` (`1192`), **but never clears `messages`**, and `Navbar.tsx` never calls `apiClient.resetActionKeys()`.
- **Minimal correct behavior**: Move chat `messages` + active hold/quote metadata into a React Context above `<RouterProvider>`, hydrate/sync per authenticated `sub` to `sessionStorage`, use client-side `navigate(...)` for `/approve/:locator`, and clear chat React state, `sessionStorage` chat key, and `apiClient.resetActionKeys()` on logout.

### 2.2 Selection Model & Hold Replacement / Release API

- **Current behavior**:
  - **2nd/3rd chip click (`handleSlotClick`, `AskAIDrawer.tsx:1264-1330`)**: Each click calls `apiClient.createBookingQuote(...)` (`1286`) and appends a new synthetic assistant message via `setMessages((prev) => [...prev, quoteMsg])` (`1313`). Every clicked slot stays rendered as an independent `<QuoteCard>` with its own live countdown timer and active `"Hold this time"` button.
  - **Clicking `"Hold this time"` twice (`handleHoldThisTime`, `AskAIDrawer.tsx:1332-1408`)**: During the in-flight request `disabled={isHolding}` (`542`) prevents clicking; once finished (`1406`), the button re-enables with no `"Held"` state. Clicking it again re-uses the same `actionScope` (`askai-prep:${quoteData.quoteId...}` at `1349`, retained in `apiClient` because `explicitKey` is passed at `api-client.ts:155`), hits backend idempotency cache, and appends a **second `<ApprovalCard>`** (`1391`).
  - **Holding a different time after a hold exists**: Uses a new `quoteId` -> new `actionScope` -> new `Idempotency-Key`, creating a **second blocking 15-minute hold in PostgreSQL** without releasing the first hold.
  - **Hold-release API discovery**:
    - There is **no `DELETE /v1/booking-holds/:id`** or dedicated release-hold route in `apps/api/src/routes/bookings.ts`. (`SchedulePage.tsx:140-148`'s "Release Hold" button only mutates local React array state cleanly without calling any backend API.)
    - Instead, `apps/api/src/routes/bookings.ts:453-479` exposes two-step cancellation: `POST /v1/bookings/:id/prepare-cancellation` (returns signed `cancellationConfirmationToken`, TTL 15 min) followed by `POST /v1/bookings/:id/cancel` (requires `Idempotency-Key` per `apps/api/src/plugins/idempotency.ts:43`).
    - Service & auth rules: `BookingService.prepareCancellation` and `commitCancellation` (`packages/application/src/booking-service.ts:1590-1594,1704-1710`) **explicitly accept `booking.status === "HELD"`** (alongside `CONFIRMED` and `CAPTURE_UNCERTAIN`), freeing `resource_claims.blocking` on commit. Route auth uses standard `registerAuth` bearer verification (`apps/api/src/plugins/auth.ts:573-684`, resolving `principal` and `tenantId`); neither route attaches `requireScopes(...)`.
- **Minimal correct behavior**: Track a single selected slot/active `QuoteCard` in drawer state (replacing the displayed quote card on subsequent slot clicks), disable `"Hold this time"` once held, and before preparing a hold for a different slot, cancel the active unapproved `HELD` booking via `/prepare-cancellation` + `/cancel` (or expose `POST /v1/booking-holds/:id/release`).

### 2.3 Duplicate Requests Analysis

Every API effect/handler in `AskAIDrawer.tsx`:

1. **`GET /v1/ai/status` on open/close (`AskAIDrawer.tsx:1097-1111`)**: `useEffect(..., [apiBaseUrl, isOpen])` lacks `if (!isOpen) return;` and a mount guard, so it fires **twice in `StrictMode` (`main.tsx:10`)** AND fires an extra `GET /v1/ai/status` **every time the drawer closes as well as opens**.
2. **`GET /v1/ai/status` after first stream (`AskAIDrawer.tsx:1172-1186`)**: Triggers on `streaming -> ready` when `!realProviderVerified` (single request per transition, safe unless `providerStatus` object churns mid-transition).
3. **`getAccessTokenSilently` warm-up (`AskAIDrawer.tsx:1899-1934`)**: Runs twice on mount in `StrictMode` (Auth0 SDK caches in-memory promise, usually deduplicated).
4. **`POST /v1/ai/chat` (`AskAIDrawer.tsx:1129-1166`)**: Called via `handleSubmit` (`1227`), `handleQuickPrompt` (`1247`), `handleRetry` (`1450`), `QuoteCard` `"Pick a different time"` (`1699`); guarded by `if (isLoading) return;` (`1230, 1248, 1451`).
5. **`POST /v1/booking-quotes` (`AskAIDrawer.tsx:1264-1330`)**: Slot buttons check `disabled={isQuoting}` (`354`) driven by React state `isQuotingSlot`, which has a synchronous double-click race window before React re-renders (no `useRef` in-flight lock).
6. **`POST /v1/bookings/prepare` (`AskAIDrawer.tsx:1332-1408`)**: Quote button checks `disabled={isHolding}` (`542`) without a synchronous `useRef` lock, **and the follow-up chip `"Hold this time"` (`1433-1445`) does not check `isHoldingSlot` at all**, allowing duplicate calls while holding is already in flight.

- **Minimal correct behavior**: Gate `/v1/ai/status` with `if (!isOpen) return;` + ref cache; add synchronous `useRef` in-flight locks on quote/prepare handlers and disable follow-up chips while `isHoldingSlot || isQuotingSlot`.

### 2.4 Loading / Streaming / Error States

- **Model streaming (`AskAIDrawer.tsx:1806-1817,1624-1636`)**: Displays a pulsing 3-dot bubble while `status` is `"submitted" | "streaming"`, a `"Stop"` button (`1863`), and per-tool `"Executing request..."` cards (`1624-1636`) when tool calls are pending.
- **Deterministic quote (`1270-1329`) / prepare (`1334-1407`)**: `handleHoldThisTime` flips button text to `"Holding slot..."` (`545`); `handleSlotClick` disables all slot buttons (`354`) **with zero visual spinner or progress copy** while quoting. Errors from either call append raw assistant text `"Unable to quote slot: ..."` (`1322`) or `"Unable to prepare hold: ..."` (`1400`) without an inline Retry or Sign-in button.
- **HTTP errors (`getErrorMessage`, `AskAIDrawer.tsx:1474-1511`)**:
  - **401 (`1476-1484`)**: Shows `"Authentication required. Please sign in with Auth0 to access the concierge."` inside `.ai-error-banner` (`1820-1835`), **with a `"Retry"` button instead of a `"Sign in"` button**.
  - **403 (`1504-1506`)**: Shows generic `"Access forbidden..."` (does not surface friendly 04A `user_not_provisioned` message).
  - **Quota exceeded / 429 (`1491-1493,1507-1509`)**: `ai.ts:167-230` returns `"ai_quota_exceeded"` which `getErrorMessage` cleanly translates to `"AI quota exceeded. Please try again later."`. However, `ai.ts:132,143` returns HTTP 429 JSON (`CONCURRENCY_LIMIT_EXCEEDED` / `RATE_LIMIT_EXCEEDED`) without `"429"` in the JSON string, so `@ai-sdk/react` error text misses `msg.includes("429")` and renders **raw JSON** in the alert banner.
  - **500 / Network loss (`1510`)**: SSE stream errors map via `ai_stream_error` / `ai_provider_unavailable` (`1495-1503`), whereas raw HTTP 500 or offline `TypeError: Failed to fetch` leaks directly via `return msg` (`1510`).
- **Minimal correct behavior**: Add a quoting status indicator, parse structured JSON/network errors safely without showing JSON or `"Failed to fetch"`, and show a Sign-In CTA for 401.

### 2.5 Follow-Up Chips

- **Current behavior (`computeFollowUpSuggestions`, `AskAIDrawer.tsx:840-891,1782-1803`)**:
  - Evaluated only on the **last message** (`messages[messages.length - 1]`). Checks tool results in priority `prepare > quote > slots > services`, returning context chips (`Open approval page` / `Find a different time`, `Hold this time` / `Pick a different time`, `Hold <firstSlot>` / `Show tomorrow morning` / `Try another day`, `Show times for <topService>` / `Compare deposits`).
  - **Cases where suggestions misfire / suggest completed or invalid actions**:
    1. Because `computeFollowUpSuggestions` uses `toolItems.find(...)` (`844,854,869`) instead of checking the _last_ item or overall conversation state, if a user asks a text-only follow-up question after getting a quote or hold (so last message has 0 tool parts), lines `886-890` fall back to default `"Show available services"`, `"Find available haircut slots tomorrow afternoon"`, `"Prepare the 2 PM slot"` — re-suggesting already completed steps.
    2. If `find_available_slots.v1` returns `slots: []` (no availability), line `874-875` falls back to `"2:00 PM"` and displays **`Hold 2:00 PM`** for a non-existent slot!
    3. After `BookingStatusCard` (`get_booking.v1`) or `CancellationCard` (`prepare_cancellation.v1`), neither card type is handled in `844-884`, so chips also fall back to `"Prepare the 2 PM slot"`.
- **Minimal correct behavior**: Compute follow-up suggestions across the conversation tail, omit `"Hold ..."` when `slots.length === 0`, handle booking-status/cancellation outputs, and use `findLast` when scanning parts.

### 2.6 Accessibility

- **Current behavior**:
  - **Open focus (`1205-1212`)**: Focuses `<input>` 50ms after `isOpen` becomes true.
  - **Close focus**: Does **not** save or restore focus to `#open-ask-ai-button` when closing.
  - **Focus trap**: Missing inside `role="dialog" aria-modal="true"` (`1523-1527`); `Tab` navigates behind the backdrop into the underlying page.
  - **Escape (`1215-1223`)**: `window` keydown listener closes the drawer reliably on `Escape`.
  - **Aria-live (`1563-1565`)**: Only announces `"Concierge response complete."` (`1173-1174`); silent on direct quote results, hold creation, errors, or Clear.
  - **Keyboard access**: Chips and action buttons are semantic `<button type="button">` elements; however `.ai-input:focus` (`index.css:1976`) sets a 1px border color change with `outline: none` (`1972`) instead of a 2px high-contrast focus ring.
- **Minimal correct behavior**: Save `document.activeElement` before opening and restore on close, trap `Tab` inside `<aside>`, announce quote/hold/error updates via `aria-live`, and keep `:focus-visible` outline on `.ai-input`.

### 2.7 Jargon & Raw Data Audit (`apps/web/src` excluding tests)

Inside `AskAIDrawer.tsx`, raw JSON, `[object Object]`, `quoteId`, `loc_`, and `valueMinor` have been eliminated; only `"SYNTHETIC DEV"` / `"LIVE DATA"` card tags (`210,320,491,635,702,769,825`) remain technical.
**Outside the drawer, developer jargon remains prominent across user-facing screens:**

- **Raw 404 string**: `"Approval interaction expired or not found"` (`packages/application/src/booking-service.ts:509`) surfaces verbatim via `err.message` in `ApprovalPage.tsx:474`.
- **`BookingSimulatorSection.tsx` (`/book`)**: `"300-second slot holds backed by cryptographic JWS signed intents"` (`363`), `"UTC Authority • GiST Lock"` (`511`), `"Slot Held (GiST Claim Locked)"` (`739`), `"Booking ID: ..."` (`749`), `"Cryptographic JWS Signed Intent (HMAC-SHA256):"` + raw signed JWT `<pre>{hold.signedIntent}</pre>` (`763-776`), `"PayPal Capture ID"`, `"Double-entry journal posted • Balanced ledger recorded"` (`813-835`).
- **`BookingPage.tsx` (`/book`)**: `"300-SECOND GiST RESERVATION"` (`29`), `"PostgreSQL secures the slot with an exclusion claim"` (`41`).
- **`SchedulePage.tsx` (`/schedule`)**: `"CONCURRENCY AUTHORITY / PostgreSQL GiST"` (`290-300`), `"Simulate Simultaneous Dual-Agent Booking Race"`, `` `POST /v1/booking-holds` `` (`499`), `"PostgreSQL exclusion constraints"` (`500`).
- **`StatusPage.tsx` (`/status`)**: `"audits RFC 9457 error contracts"` (`94`), `"POSTGRESQL 17+ / BTREE_GIST"` (`167`), `"Temporal GiST exclusion locks active"` (`184`), `"Transactional Outbox dispatcher active"` (`213`), raw service UUID in probe button (`270`).
- **`HomePage.tsx:53`, `ProtocolSection.tsx:24,56`, `GeometrySection.tsx:73`**: Expose `"GiST lock"`, `"REST, MCP, WebMCP"`, `"Tenant context"`, and `"PostgreSQL exclusion constraint"`.

---

## 3. Approval page findings (`apps/web/src/pages/ApprovalPage.tsx`)

### 3.1 States, Triggers & "Not Found" Attribution Leak

All 12 `ApprovalPageState` values (`apps/web/src/pages/ApprovalPage.tsx:13-25`):

1. `loading`: Initial state (`42`), start of `loadDetails` (`75`), or when `isAuthLoading` is true (`101-103`).
2. `sign_in_required`: `loadDetails` succeeds, hold not consumed/expired, and `!isAuthLoading && !isAuthenticated` (`106-108`).
3. `ready`: `loadDetails` succeeds, hold active, `!isAuthLoading && isAuthenticated` (`111`).
4. `wrong_buyer`: `handleApproveAndCommit` or `handleApproveOnly` catches HTTP `403` with `BUYER_MISMATCH` or `APPROVAL_BELONGS_TO_ANOTHER_BUYER` (`216-221,242-247`).
5. `expired`: `expiresAtMs <= serverNow` (`95-96`), `410`/`HOLD_EXPIRED` from fetch or commit (`114-115,222-223,248-249`), or live countdown reaching `0` while `pageState === "ready"` (`138-140`).
6. `committing`: Entered at start of `handleApproveAndCommit` (`179`) or `handleApproveOnly` (`233`).
7. `pay_deposit`: `approveAndCommit` returns `status === "COMMITTING" && next.type === "PAY_DEPOSIT"` (`202-208`), or user clicks `"Try again"` from `payment_failed` (`600`).
8. `verifying_payment`: JSX exists at `561-578`, **but `setPageState("verifying_payment")` is never called anywhere** (unreachable dead state).
9. `confirmed`: `approveAndCommit` returns `CONFIRMED` (`209-210`) or `handlePaymentOutcome` receives `bookingStatus === "CONFIRMED"` (`259-261`).
10. `payment_failed`: `handlePaymentOutcome` receives any `outcome.bookingStatus !== "CONFIRMED"` (`262-265`), **including `CAPTURE_UNCERTAIN`**.
11. `already_done`: `loadDetails` finds `status === "CONSUMED" || bookingStatus === "CONFIRMED"` (`88-91`), `approveAndCommit` returns unexpected status (`212`), or `handleApproveOnly` succeeds (`239`).
12. `error`: `loadDetails` catches non-410 errors including `404 APPROVAL_NOT_FOUND` (`117-118`), or approve handlers catch non-403/410 errors (`225-226,251-252`).

**"Not found" attribution bug confirmed**: When `GET /v1/booking-approvals/:locator` returns 404 (`pageState === "error"`, `details === null`), `attributionText` returns `"Prepared by Ask AI"` (`352`), the `<h1>` renders `"Review & Approve. Your AI assistant reserved this time for you."` (`415-419`), `<p className="lede">` renders `"Your AI assistant reserved this time for you. Review and approve to book."` (`429`), and the error panel shows `"Approval interaction expired or not found"` (`474`).

### 3.2 Duplicated Sentence Location

`"Your AI assistant reserved this time for you."` renders twice back-to-back in the hero header of `ApprovalPage.tsx`:

- First in `<h1>` (`apps/web/src/pages/ApprovalPage.tsx:418`: `<span className="accent">Your AI assistant reserved this time for you.</span>`).
- Immediately below in `<p className="lede">` (`apps/web/src/pages/ApprovalPage.tsx:429`: `"Your AI assistant reserved this time for you. Review and approve to book."`).

### 3.3 Why `GET /v1/booking-approvals/:locator` Fires 4 Times

`loadDetails` (`ApprovalPage.tsx:74-121`) lists `[locator, isAuthLoading, isAuthenticated]` in its `useCallback` dependencies (`121`), and `useEffect` (`123-127`) re-runs `loadDetails()` on every identity change:

1. Initial mount (`isAuthLoading=true`) -> GET #1
2. `<React.StrictMode>` (`apps/web/src/main.tsx:10`) dev double-effect -> GET #2
3. Auth0 SDK finishes loading (`isAuthLoading: true -> false`) -> GET #3
4. Auth0 restores session (`isAuthenticated: false -> true`) -> GET #4

Even though `fetchApprovalDetails` sends a public unauthenticated `GET`, Auth0 state transitions force redundant reloads (and can reset `pageState` if Auth0 token refresh alters state).

### 3.4 Payment Step Trace (`PayPalButton.tsx` & `ApprovalPage.tsx`)

| Step                 | Trigger & Location                                                                                   | Method & URL                                                       | `Idempotency-Key`                                                                                                                                                      | `Authorization`                                                                                                           | Retry / Double-Click Behavior                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve & Commit     | Click `"Approve and continue to payment"` (`ApprovalPage.tsx:171-199`)                               | `POST /v1/booking-approvals/:locator/approve-and-commit`           | Yes — stored in `approveCommitKeyRef` per `locator` (`189-194`), retained across retries via `keepKeyOnSuccess: true` (`api-client.ts:409`).                           | Yes — `Bearer` from `getAccessTokenSilently()` (`ApprovalPage.tsx:158-163`, synced to `apiClient.setAuthToken` at `185`). | `setPageState("committing")` unmounts the ready card (`750` vs `541` vs `823`), preventing 2nd click once committed, though a same-tick click before state flush replays the same `approveCommitKeyRef` safely.                                                   |
| Create Payment Order | Mount `useEffect` (`PayPalButton.tsx:194-204`), SDK `createOrder` (`264`), or fallback click (`325`) | `POST /v1/bookings/:bookingId/payment-order` (`api-client.ts:456`) | Yes — passed from `ApprovalPage` (`paymentOrderKeys`, `203-207`) or fallback `fallbackOrderKeyRef` (`PayPalButton.tsx:120-130`); reused across `"Try again"` remounts. | Yes — via `apiClient.request` (`this.tokenProvider` / `this.authToken`).                                                  | `inFlightOrderRef` (`165-167`) and `paymentIntentIdRef` (`158-163`) deduplicate concurrent/repeat calls on the same mount; if order creation errors on mount, `error` shows inline and user can retry SDK/fallback with the same key.                             |
| Capture Payment      | PayPal `onApprove` (`PayPalButton.tsx:273-286`) or fallback click (`327`)                            | `POST /v1/payments/:paymentIntentId/capture` (`api-client.ts:485`) | Yes — `getCaptureIdempotencyKey(intentId)` stored in `ApprovalPage`'s `captureKeysRef` Map (`56-64`) or `fallbackCaptureKeysRef` (`132-144`).                          | Yes — via `apiClient.request`.                                                                                            | Button uses `disabled={isExpired \|\| isProcessing}` (`398`); lacks a synchronous `useRef` click guard in `handlePaymentClick`, and in SDK mode `initV6Session` (`248-305`) recreates PayPal sessions cleanly on dep change without tearing down prior instances. |
| Status Polling       | _Not wired_                                                                                          | `GET /v1/operations/:operationId` (`api-client.ts:540-548`)        | N/A                                                                                                                                                                    | Yes (if called)                                                                                                           | `getOperation` exists on `apiClient`, **but neither `ApprovalPage` nor `PayPalButton` ever polls it**.                                                                                                                                                            |

### 3.5 Countdown Behavior

- **Time source (`ApprovalPage.tsx:81-82,130-135`, `approval-api.ts:32-33`)**: Derives `serverTimeOffset = new Date(res.headers.get("date")).getTime() - Date.now()`. However, Fastify `cors` (`apps/api/src/app.ts:93-106`) does **not** set `exposedHeaders: ["Date"]`, so cross-origin browsers (`5174 -> 3001`) will read `res.headers.get("date") === null` and silently fall back to local `Date.now()`. Separately, `PayPalButton.tsx:213-220` runs its own countdown from `paymentExpiresAt` using raw `Date.now()` without `serverTimeOffset`.
- **Tab sleep behavior**: Both components recompute `(targetMs - Date.now()) / 1000` on each 1-second `setInterval` (`ApprovalPage.tsx:68,132`, `PayPalButton.tsx:215`), so waking a sleeping tab snaps cleanly to actual elapsed wall time rather than drifting by missed ticks.
- **Behavior at 0**:
  - In `pageState === "ready"`, `ApprovalPage.tsx:139` switches cleanly to `"expired"`.
  - In `pageState === "sign_in_required"`, line `139` does **not** trigger `"expired"`, leaving expired hold terms and `"Sign in to approve"` clickable at `0:00`.
  - In `pageState === "pay_deposit"`, `ApprovalPage` does **not** pass `onPaymentExpired` (`809-818`), so `ApprovalPage` keeps showing `"Hold Reserved. Deposit required to confirm."` (`770`) while `PayPalButton` switches to `"Payment Window Expired - Slot Released"` (`404`) and `"Please return to schedule..."` (`416`) with no link.

### 3.6 Post-`CONFIRMED` Flow & Dead Ends

After `confirmed` (`ApprovalPage.tsx:659-747`), the UI renders only `<Link to="/schedule">View in Schedule -></Link>` (`732`) and an external Google Calendar `<a>` (`736`):

- Clicking `View in Schedule ->` opens `SchedulePage`, which shows hardcoded `INITIAL_SCHEDULE` demo data (`SchedulePage.tsx:16-65`) rather than the user's confirmed booking — **a functional dead end**.
- There is no button/link back to `/` (Overview), `/book`, or `"Book another / Ask AI"`.

---

## 4. Cross-cutting findings

### 4.1 Every Mutating Request in `apps/web/src`

| File:Line                                           | Method & Endpoint                                        | Caller(s)                                                                  | `Idempotency-Key`                                                                | `Authorization`                                                            |
| --------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/web/src/api-client.ts:282-291`                | `POST /v1/booking-quotes`                                | `AskAIDrawer.tsx:1286`, `BookingSimulatorSection.tsx:249`, `webmcp.ts:138` | Yes (auto/reused via `withRetryIdempotencyKey`)                                  | Yes (Bearer or throws 401 if Auth0 on & no token; test token in mock mode) |
| `apps/web/src/api-client.ts:314-321`                | `POST /v1/bookings/prepare`                              | `AskAIDrawer.tsx:1351`, `webmcp.ts:178`                                    | Yes (`askai-prep:...` key passed & reused per quote)                             | Yes (`apiClient.request`)                                                  |
| `apps/web/src/api-client.ts:344-350`                | `POST /v1/booking-holds`                                 | `BookingSimulatorSection.tsx:329`, `SchedulePage.tsx:102,110`              | Yes (`withRetryIdempotencyKey` or explicit race keys)                            | Yes (`apiClient.request`; fails 401 when signed out)                       |
| `apps/web/src/api-client.ts:375-381`                | `POST /v1/risk/evaluate`                                 | `RuntimePolicySection.tsx:60`                                              | Yes (`withRetryIdempotencyKey` + `request()` guard; route is exempt server-side) | Yes (`apiClient.request`; silently swallowed on 401 when signed out)       |
| `apps/web/src/api-client.ts:398-408`                | `POST /v1/booking-approvals/:locator/approve-and-commit` | `approval-api.ts:46` <- `ApprovalPage.tsx:195`                             | Yes (`approveCommitKeyRef`, `keepKeyOnSuccess: true`)                            | Yes (`token` override passed from `getAccessTokenSilently()`)              |
| `apps/web/src/api-client.ts:425-435`                | `POST /v1/booking-approvals/:locator/confirm`            | `approval-api.ts:57` <- `ApprovalPage.tsx:238`                             | Yes (`withRetryIdempotencyKey`, `keepKeyOnSuccess: true`)                        | Yes (`token` override passed from `getAccessTokenSilently()`)              |
| `apps/web/src/api-client.ts:456-462`                | `POST /v1/bookings/:bookingId/payment-order`             | `PayPalButton.tsx:170`                                                     | Yes (`paymentOrderKeys` or `fallbackOrderKeyRef`)                                | Yes (`apiClient.request`)                                                  |
| `apps/web/src/api-client.ts:485-491`                | `POST /v1/payments/:paymentIntentId/capture`             | `PayPalButton.tsx:279,327`                                                 | Yes (`captureKeysRef` per `paymentIntentId`)                                     | Yes (`apiClient.request`)                                                  |
| `apps/web/src/api-client.ts:507-513`                | `POST /v1/bookings/:bookingId/prepare-cancellation`      | _No active web callers_                                                    | Yes                                                                              | Yes                                                                        |
| `apps/web/src/api-client.ts:529-535`                | `POST /v1/bookings/:bookingId/cancel`                    | _No active web callers_                                                    | Yes                                                                              | Yes                                                                        |
| `apps/web/src/api-client.ts:565-574`                | `POST /v1/bookings/commit`                               | `webmcp.ts:264`                                                            | Yes                                                                              | Yes                                                                        |
| `apps/web/src/components/AskAIDrawer.tsx:1131-1160` | `POST /v1/ai/chat` (`DefaultChatTransport`)              | `useChat` in `AskAIDrawerInner`                                            | **No** (streaming chat; not in server `MUTATING_ROUTES_REQUIRING_IDEMPOTENCY`)   | Yes (`Bearer` resolved via `tokenResolver` or throws `AUTH_REQUIRED`)      |

### 4.2 Auth Audit

- **Places reading `useAuth0` / `isAuthenticated` / `getAccessTokenSilently`**:
  - `apps/web/src/components/Navbar.tsx:2,9,15,34,44,52,84,207`
  - `apps/web/src/components/AskAIDrawer.tsx:14,1085,1189-1195,1232,1250,1850,1888-1968`
  - `apps/web/src/pages/ApprovalPage.tsx:2,33-38,106,121,158,172`
- **Public access & signed-out behavior vs WP 04A expectations**:
  - **Home (`/`)**: Renders publicly; does not hit protected APIs on load.
  - **`/v1/services` & `/v1/availability`**: Backend `auth.ts:596-615` permits unauthenticated GETs cleanly, so catalog/slots on `/book` and probes on `/status` load when signed out.
  - **`BookingSimulatorSection` (`/book`)**: Calls `apiClient.createBookingQuote(...)` automatically via `useEffect` (`293-299`) without checking Auth0 state -> throws 401 `"Authentication required..."` into `quoteError` right on first paint when signed out! Also pre-fills customer input with a hardcoded internal email string (`103`) instead of signed-in `user.email`.
  - **`SchedulePage` (`/schedule`)**: Reads 0 API endpoints on load; renders hardcoded `INITIAL_SCHEDULE` (`16-65`) containing sample buyer email strings and misses the 04A read-only demo banner `"Demo schedule (read-only). Sign in to book or run the race test."`; clicking `"Execute Concurrency Race Trial"` fails with 401 when signed out.
  - **`RuntimePolicySection` (`/policy`)**: Works visually when signed out; background `apiClient.evaluateRisk` fails 401 silently inside `try/catch`.
  - **`/security` (from 04A Part 4)**: Not implemented in `apps/web/src/App.tsx:86-104` (falls through to `<HomePage />`).
  - **Signed-out Ask AI**: Input shows disabled title tooltip; no Sign-in button inside drawer; pressing quick pills triggers `"Concierge Alert: Authentication required..."` + non-functional `"Retry"` button instead of an explanation + sign-in CTA (04A Part 5).

### 4.3 Navigation

- **Full page reloads caused by native `<a>` / `window.location.href`**:
  - `apps/web/src/components/AskAIDrawer.tsx:660` (`<a href={approvalUrl} target="_self">Open approval page</a>`) and `AskAIDrawer.tsx:1427` (`window.location.href = targetUrl` in `"Open approval page"` follow-up handler).
  - `apps/web/src/components/SafeMarkdown.tsx:46`: markdown links use raw `<a>` even for internal routes (external links correctly use `_blank`).
- **Deep links**: Unknown paths silently render `<HomePage />` (`App.tsx:100-103`, no 404 UI). Navigating to `/approve/` (trailing slash, empty `locator`) stays stuck on `loading` (`ApprovalPage.tsx:124: if (locator)`).
- **Back-button behavior**: `RouterProvider` listens to `popstate` (`router.tsx:28-35`). Note that after full reload from Ask AI's `<a href>`, hitting Back reloads `/` clean with lost Ask AI state; hitting Back _to_ an already-paid `/approve/:locator` re-fetches `loadDetails` and safely shows `already_done` (`CONSUMED`).

### 4.4 Visual Consistency & 390px Mobile Risks

- **Undefined CSS classes & custom properties**:
  - `ApprovalPage.tsx` uses `var(--text-dim)` (`453,695,715,724,797,803,869,880,903,912,922,942,961,1020`) and `var(--text-body)` (`473,496,635,685,773,781,855`) — **neither exists in `apps/web/src/index.css`**, collapsing secondary hierarchy to inherited `#0d0d0f`. Also applies dark-mode shadow `0 20px 40px rgba(0, 0, 0, 0.4)` (`666,757,830`) on light `--stage` (`#e4e4e2`) cards.
  - `.spinner` (`ApprovalPage.tsx:452,552,572`), `.text-muted` (`ApprovalPage.tsx:725`, `AskAIDrawer.tsx:265,648,726,791,1627`), `.button--primary`, `.button--secondary`, `.button--sm`, `.button--outline`, `.button--ghost`, and `.signal-dot--red/gold/amber` (`AskAIDrawer.tsx:531-550,1865`, `Navbar.tsx:188,254,269,407`, `ApprovalPage.tsx:382-383,852,1018`, `BookingSimulatorSection.tsx:384,411,866`) have **no CSS rules in `index.css`**.
  - On dark `.ai-quote-card` (`#1a1b23`), `"Hold this time"` and `"Pick a different time"` (`AskAIDrawer.tsx:540,550`) fall back to `.button` (`background: transparent; border: 1px solid rgba(13,13,15,0.12)`), making button borders nearly invisible against dark cards.
  - Dark-theme muted text `.ai-tool-count` / `.ai-tool-time` / `.ai-followup-label` use `#6b7280` on `#17171b` / `#141417` (`index.css:1825,1920`, contrast ~3.8:1 < 4.5:1).
- **390px mobile layout risks**:
  1. `.nav-links { display: none; }` at `@media (max-width: 980px)` (`index.css:1055-1058`) hides all secondary route links with **no mobile menu**, stranding mobile visitors off `/schedule`, `/policy`, `/status`.
  2. `.nav-actions` (`Navbar.tsx:382-428`, `index.css:215-219,1092-1099`) places `API status + Ask AI + Auth0 status/name/Logout + Book Now` in one single non-wrapping flex bar inside `height: 58px`, overflowing 390px horizontally when signed in.
  3. `StatusPage.tsx:265` endpoint selector buttons lack `flexWrap: "wrap"` inside header flex container, squeezing/overflowing on 390px.
  4. `HomePage.tsx` uses `minmax(280px, 1fr)` cleanly (fits 350px content width inside 20px padding), while `.hero-subject` (`right: -33vw; width: 108vw`, `index.css:1124-1126`) and `Close` CTA grid (`minmax(240px, 0.8fr)`, `996`) rely on `overflow: clip`.
  5. `.ai-input` inside `.ai-drawer-form` (`index.css:1955-1974`) lacks `min-width: 0` alongside Send button inside 94vw (~366px).

### 4.5 Console Noise in Production Paths (`apps/web/src` excluding tests)

Zero `console.log` statements remain. Active `console.error` / `console.warn` calls in source:

- `apps/web/src/api-client.ts:87` (`console.error` when `VITE_API_BASE_URL` missing in prod)
- `apps/web/src/api-client.ts:167` (`console.error` when API request blocked without baseUrl)
- `apps/web/src/components/AskAIDrawer.tsx:1315` (`console.error("Failed to quote slot directly:", err)`)
- `apps/web/src/components/AskAIDrawer.tsx:1393` (`console.error("Failed to prepare hold directly:", err)`)
- `apps/web/src/components/ErrorBoundary.tsx:29` (`console.error`)
- `apps/web/src/lib/webmcp.ts:282` (`console.warn`)

### 4.6 Bundle Size & Lazy Loading

- Built output (`apps/web/dist/assets`): single JS chunk `index-D_tuABNe.js` = **`1,360.09 kB`** (`1,360,094` bytes, **`356.02 kB` gzip**); CSS = **`27.37 kB`** (`6.68 kB` gzip). Vite build emits `(!) Some chunks are larger than 500 kB after minification.`
- Heavy imports loaded eagerly in `App.tsx:8-14` (`React.lazy` is not used anywhere): `AskAIDrawer` (`@ai-sdk/react` + `ai` + `react-markdown` + `zod`) and all 6 routes including `ApprovalPage` (`PayPalButton` injects external `v6/core` script lazily at runtime, `PayPalButton.tsx:47-67`, which is good, while its TS wrapper stays eager).

### 4.7 Static Assets & SEO Metadata

- **Favicon**: **Missing.** No `<link rel="icon">` in `apps/web/index.html` and no `apps/web/public/` folder -> `/favicon.ico` returns 404.
- **Page titles per route**: Static `<title>velvetAI — AI books it. PayPal seals it.</title>` (`apps/web/index.html:10`); never updated per route.
- **Meta description / Open Graph**: `<meta name="description">` present (`index.html:6-9`); **no `og:*` Open Graph tags** (`og:title`, `og:description`, `og:type`, `og:image`).

---

## 5. Scenario walk-through results (A–H)

- **Scenario A — Signed-out visitor opens `/` -> Ask AI -> asks for services -> tries to hold a time**
  1. `/` loads cleanly (`HomePage` has no auth calls); clicking `✦ Ask AI` opens `AskAIDrawer` (`App.tsx:132`).
  2. When Auth0 is configured and visitor is signed out (`AskAIDrawer.tsx:1084-1085`), `<input>` and `Send` are disabled (`1859,1875`).
  3. Three empty-state quick prompt pills (`1578-1602`: `"Show available services"`, etc.) look clickable and are NOT disabled; clicking any calls `handleQuickPrompt` (`1247-1258`) -> sets `authPromptError` -> opens red alert `"Concierge Alert: Authentication required..."` (`1820-1835`) with a `"Retry"` button (`handleRetry` triggers `regenerate()` or `sendMessage` -> still 401/`AUTH_REQUIRED`, **no Sign-In button**). Visitor never sees services in Ask AI and never reaches hold creation.

- **Scenario B — Signed-in buyer: Ask AI -> tomorrow afternoon -> clicks 3 different times -> holds last -> approves -> PayPal -> confirmed -> Home -> reopens Ask AI**
  1. Model calls `find_available_slots.v1` with `day`/`dayPart`; `<SlotsCard>` renders interactive chips with merchant TZ + `"Your time"`.
  2. Clicking 3 different slot buttons triggers `POST /v1/booking-quotes` 3 times and **appends 3 separate `<QuoteCard>` assistant messages** (`1313`) instead of replacing the selection.
  3. Clicking `"Hold this time"` on the last `<QuoteCard>` calls `POST /v1/bookings/prepare` (`1351`) with an `askai-prep:...` `Idempotency-Key` and appends `<ApprovalCard>`.
  4. Clicking `"Open approval page"` (`<a href={approvalUrl} target="_self">` at `660` or `window.location.href` at `1427`) performs a **full browser reload**, destroying Ask AI chat history.
  5. `/approve/:locator` fires `GET /v1/booking-approvals/:locator` 3–4 times (`ApprovalPage.tsx:74-127`), displays duplicated `"Your AI assistant reserved this time for you."` (`418,429`), checks `"I agree to these terms"`, calls `POST .../approve-and-commit` with `approveCommitKeyRef` -> enters `pay_deposit` with an invisible `.spinner` while committing.
  6. `PayPalButton` creates `POST /v1/bookings/:id/payment-order` on mount (`194-204`) with `Idempotency-Key` + Bearer token, opens PayPal v6 session (or fallback capture), captures with `captureKeysRef` key -> transitions to `confirmed` (`ApprovalPage.tsx:261`).
  7. From `confirmed`, **there is no link back to `/` or Ask AI** (`731-745`); only `"View in Schedule ->"` (which opens static mock data) or Google Calendar. Returning to `/` via URL/Back shows a blank Ask AI drawer (chat lost on step 4 reload).

- **Scenario C — Buyer opens MCP agent approval link -> clicks "Approve only" -> agent commits**
  1. `GET /v1/booking-approvals/:locator` shows `"PREPARED BY AN EXTERNAL AI AGENT (MCP)"` (`354,865`) and renders secondary button `"Approve only (let my assistant finish)"` (`1015-1024`).
  2. Clicking `"Approve only"` calls `handleApproveOnly` (`232-255`) -> `postConfirmApproval` (`POST /v1/booking-approvals/:locator/confirm` with `confirmApproval` idempotency key and Bearer token) -> backend claims unassigned M2M hold (`booking-service.ts:688-695`) and issues confirmation token hash in DB.
  3. **UI defect (`239`)**: `handleApproveOnly` immediately calls `setPageState("already_done")`! Screen renders `"This booking has already been confirmed. Your reservation is securely recorded."` (`632-637`) even though the booking is still `HELD` / uncommitted and unpaid until the MCP agent invokes `commit_booking.v1` and payment completes. (Reloading `/approve/:locator` later reads `status === "APPROVED"` and switches back to `ready`!)

- **Scenario D — Hold expires while buyer is on PayPal popup**
  1. While buyer is in the popup, `ApprovalPage` is in `pay_deposit` (`750`). Line `139` (`if (details && pageState === "ready" && remainingSeconds <= 0)`) does **not** run in `pay_deposit`.
  2. `<PayPalButton>` has no `onPaymentExpired` callback passed from `ApprovalPage` (`809-818`). Its internal `paymentExpiresAt` timer hits `0` (`PayPalButton.tsx:217-219`), switching the PayPal widget to `"PAYMENT WINDOW EXPIRED"` and `"Slot hold released. Please return to schedule to select a new time slot."` (no clickable link), while `ApprovalPage`'s top banner keeps claiming `"Hold Reserved. Deposit required to confirm."` (`770`).
  3. If the buyer clicks Pay right inside the open popup after hold expiry, backend `capturePayment` fails; `PayPalButton` catches the error locally into its inline red error box (`281-282`) without telling `ApprovalPage` the hold expired.

- **Scenario E — PayPal popup closed/cancelled by buyer**
  1. SDK invokes `onCancel` (`PayPalButton.tsx:287-289`), which calls `onCancel?.()`.
  2. Because `ApprovalPage.tsx:809-818` never passes an `onCancel` prop, nothing in `ApprovalPage` notifies the user (`isProcessing` resets via `handlePaymentClick` `finally` block at `318`). If the SDK treats popup close as a promise rejection in `sessionRef.current.start()`, `315-316` displays red error `"PayPal checkout session failed"`.

- **Scenario F — Buyer double-clicks "Approve and continue to payment"**
  1. Click #1 runs `handleApproveAndCommit` (`171`), generates/stores `approveCommitKeyRef.current` (`189-194`), sets `pageState("committing")` (`179`), and awaits `getAuthToken()` (`183`).
  2. During the microtask before React commits `setPageState("committing")` (which unmounts the button), a second synchronous click re-enters `handleApproveAndCommit`, **reuses the exact same `approveCommitKeyRef.current.key`** (`189` checks `locator`), and sends the identical `Idempotency-Key` to `/approve-and-commit`, where backend idempotency converges safely without double commit.

- **Scenario G — Second buyer opens first buyer's approval link**
  1. `GET /v1/booking-approvals/:locator` is unauthenticated (`auth.ts:584`) and succeeds (`pageState = "ready"` once signed in as Buyer B), showing terms without validating buyer ownership upfront.
  2. Buyer B ticks `"I agree to these terms"` (`1001`) and clicks `"Approve and continue to payment"` (`1030`) -> backend rejects with HTTP `403 BUYER_MISMATCH` (`booking-service.ts:727-728` / `892`).
  3. `ApprovalPage.tsx:216-221` catches `403 BUYER_MISMATCH`, transitions to `wrong_buyer` (`483-514`), showing `"This approval belongs to another account."` and `"Sign in with another account"` (`prompt: "login"`, `506`). Zero DB state change.

- **Scenario H — Network drops during capture (`CAPTURE_UNCERTAIN`)**
  1. **Browser-to-API network drop during `apiClient.capturePayment` (`PayPalButton.tsx:279,327`)**: `fetch` rejects with `TypeError: Failed to fetch` -> caught inside `PayPalButton.tsx:281-282` (`329-330` in fallback) -> displays raw inline error (`"Failed to fetch"`). `ApprovalPage` stays in `pay_deposit`; `onPaymentOutcome` is never called; `apiClient.getOperation()` is never invoked; in SDK mode re-clicking the PayPal button re-opens a new popup rather than retrying capture directly.
  2. **API-to-PayPal network drop returning HTTP `202 { bookingStatus: "CAPTURE_UNCERTAIN", paymentStatus: "UNCERTAIN", operationId }` (`payments.ts:79-82`)**: `PayPalButton` passes `outcome` to `ApprovalPage.handlePaymentOutcome` (`258-266`). Line `259` checks only `outcome.bookingStatus === "CONFIRMED"`, so **`CAPTURE_UNCERTAIN` falls into `else`**, setting `pageState("payment_failed")` with inaccurate copy `"Payment capture was unsuccessful. Your hold remains active."` (`263`) and showing `"Try again"` (`602`), **never polling `GET /v1/operations/:operationId`**.

---

## 6. Already-reported issues: current status

| Reported issue                                                | Current status                                                      | Evidence (`file:line`)                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayPal step on `/approve` missing `Idempotency-Key`           | **Fixed**                                                           | `PayPalButton.tsx:120-145,169-170,278-279,326-327`, `ApprovalPage.tsx:53-64,189-207`, `api-client.ts:204-210,440-494` — all `payment-order`, `capture`, `approve-and-commit`, and `confirm` calls attach & reuse `Idempotency-Key`.                                             |
| Ask AI chat history lost on drawer close/reopen or navigation | **Still present (on approval navigation / reload / auth redirect)** | `App.tsx:137` + `AskAIDrawer.tsx:1513` preserve state on simple close/open, **but** `"Open approval page"` at `AskAIDrawer.tsx:660` (`<a href>`) and `1427` (`window.location.href`) reloads the document and wipes `useChat` memory.                                           |
| Clicking several time chips appends quote card per click      | **Still present**                                                   | `AskAIDrawer.tsx:1313` unconditionally runs `setMessages((prev) => [...prev, quoteMsg])` on every slot click.                                                                                                                                                                   |
| Hardcoded `localhost:3000` URLs in web app                    | **Fixed**                                                           | Replaced across `Navbar.tsx`, `BookingSimulatorSection.tsx`, `RuntimePolicySection.tsx`, `SchedulePage.tsx`, `ApprovalPage.tsx`, `StatusPage.tsx` with `apiClient` / `API_BASE_URL` (only `api-client.ts:93` dev fallback & Vitest `test-setup.ts:14` retain `localhost:3000`). |
| Rules-of-Hooks crash in `Navbar.tsx`                          | **Fixed**                                                           | Hooks (`useState`/`useEffect` at `Navbar.tsx:8-114`) now all precede conditional returns (`Navbar.tsx:140+`), verified by ESLint `0 errors` and `auth0-login.test.tsx` test 9.                                                                                                  |
| Auth0 `?code`/`state` callback params not cleaned             | **Fixed**                                                           | Handled by `cleanStaleAuthParams` (`auth-config.ts:120-176`) + `onRedirectCallback` (`App.tsx:185-191`) + stale error cleaner (`Navbar.tsx:92-114`).                                                                                                                            |
| Wrong dates in Ask AI                                         | **Fixed (server-side)**                                             | Backend `apps/api/src/routes/ai.ts:380-402` injects current salon date/time + `day`/`dayPart` parameters; drawer displays resolved `display.localDate` (`AskAIDrawer.tsx:297,426-453`).                                                                                         |
| Black-on-black card headers                                   | **Fixed**                                                           | `.ai-tool-card-header` (`index.css:1405-1414`: `#17171b` / `#9ba0a6`) and `.ai-tool-action-name` (`index.css:1818-1821`: `#ffffff`) have high contrast; note `--text-dim`/`--text-body` on light `ApprovalPage` remain undefined.                                               |
| `"Approval interaction expired or not found"` jargon          | **Still present**                                                   | `packages/application/src/booking-service.ts:509` throws exact string; `ApprovalPage.tsx:117,474` renders it verbatim on 404.                                                                                                                                                   |
| `GET /v1/booking-approvals/:locator` fired 4 times            | **Still present**                                                   | `ApprovalPage.tsx:74-127` still has `[locator, isAuthLoading, isAuthenticated]` deps causing StrictMode + Auth0 multi-fetch.                                                                                                                                                    |
| Favicon 404                                                   | **Still present**                                                   | `apps/web/index.html` lacks `<link rel="icon">` and `apps/web/public/` does not exist.                                                                                                                                                                                          |

---

## 7. Quick wins (< 15 min each)

1. **Fix `GET /v1/booking-approvals/:locator` 4x fetch** (`ApprovalPage.tsx:74-127`): Remove `isAuthLoading`/`isAuthenticated` from `loadDetails` fetch trigger (derive `sign_in_required` vs `ready` in a separate lightweight effect once `details` + Auth0 settle).
2. **Fix `"Open approval page"` full-page reload** (`AskAIDrawer.tsx:660,1427`): Use `<Link to={\`/approve/${cleanLocator}\`} onClick={onClose}>`and`useRouter().navigate(...)` so Ask AI chat state survives navigation.
3. **Remove duplicate `"Your AI assistant reserved this time for you."` & fix 404 attribution** (`ApprovalPage.tsx:351-352,415-430`): Only render AI reservation headline when `details` exists and `pageState !== "error"`, and replace `"Approval interaction expired or not found"` (`booking-service.ts:509` or mapped UI copy in `ApprovalPage.tsx:113-118`) with `"This booking link wasn't found or has expired."`.
4. **Stop `GET /v1/ai/status` firing on drawer close** (`AskAIDrawer.tsx:1097-1111`): Early return `if (!isOpen) return;` at line 1098.
5. **Define missing CSS classes in `apps/web/src/index.css`**: Add `.spinner`, `--text-dim`, `--text-body`, `.text-muted`, `.button--primary`, `.button--secondary`, `.button--outline`, `.button--ghost`, `.button--sm`, and `.signal-dot--red/amber/gold` (`~15` lines).
6. **Add `<link rel="icon">` data-URI or SVG icon + `og:*` tags** in `apps/web/index.html` to stop `/favicon.ico` 404s immediately.
7. **Fix `SlotsCard` empty-list follow-up `"Hold 2:00 PM"`** (`AskAIDrawer.tsx:872-876`): Only emit `"Hold ${timeLabel}"` when `slots.length > 0`.
8. **Suppress initial signed-out 401 quote error on `/book`** (`BookingSimulatorSection.tsx:293-299`): Skip auto-fetching `POST /v1/booking-quotes` until authenticated (or show `"Sign in to calculate live quote & lock hold"`).
