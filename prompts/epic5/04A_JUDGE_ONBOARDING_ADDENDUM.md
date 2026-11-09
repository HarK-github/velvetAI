# Epic 5 · Work Package 04A — Judge Onboarding and First-Run Access (addendum to 04)

Priority: P0 (gates every judge-facing feature) · Owner: Track A (backend + Auth0 steps), small UI parts listed for Track B in 05 · Time box: half a day · Read `prompts/epic5/00_OPERATING_RULES.md`, `PARALLEL_RULES.md`, and `04_JUDGE_TENANT_SEED_AND_RESET.md` first. Do this together with 04 (same branch, after the judge tenant exists).

## Problem

A judge who opens the hosted site today cannot use it without help:

1. There is no self-service account; a new Auth0 user gets HTTP 403 `user_not_provisioned` on every protected route because no local `app_users` / `memberships` row exists. Provisioning only happens through the manual CLI `pnpm auth:provision-test-user`.
2. Ask AI, the approval page and payment all require login, so the winning features are invisible until login works.
3. The Auth0 password policy is strict, and signup may be disabled.

## Target experience

```text
open site → explore without login (home, services, availability, /security, read-only /schedule demo)
→ "Sign in or create account" (email+password or Continue with Google)
→ back on the same page, automatically a BUYER in the judge tenant
→ Ask AI → approve → pay with the PayPal Sandbox buyer from the Devpost testing instructions
```

Judges who use the pre-made judge account additionally get merchant + judge tools.

## Part 1 — Just-in-time (JIT) buyer provisioning (API)

Location: the Auth0 authentication adapter in `apps/api/src/plugins/auth.ts` (where `user_not_provisioned` is raised today) plus a small application service, for example `packages/application/src/onboarding-service.ts`.

Rules:

1. Trigger only when ALL are true:
   - Valid Auth0 USER access token for the API audience (never M2M `@clients`, never dev tokens).
   - No local `app_users` row for the `sub`.
   - Environment flag `SELF_SIGNUP_ENABLED=true` (default false; true on Render and locally for the demo).
2. In one transaction: create `app_users` (sub, created_at; no email stored unless the table already stores it — do not add PII), create a membership in `SELF_SIGNUP_TENANT_ID` (default the judge tenant `01932b10-0000-7000-8000-000000000a01`; fall back to the dev tenant only if the judge tenant does not exist yet, and log which) with role BUYER only, role_version 1, status ACTIVE. Append an audit event `user.self_provisioned`.
3. Idempotent under concurrency: two first requests at the same time create exactly one user and one membership (use the existing unique constraints with ON CONFLICT DO NOTHING, then re-read).
4. Never grant MERCHANT, SCHEDULER, OWNER, or JUDGE through JIT. Never JIT-provision into any tenant other than `SELF_SIGNUP_TENANT_ID`.
5. Rate limit JIT creations: max 30 new users per hour per IP and 500 per day globally; over the limit return 429 with a friendly message.
6. If the email is not verified in the token claims and the tenant requires verification, still allow BUYER (sandbox demo) but record `email_verified=false` in the audit event. Do not block judges on email verification.
7. Existing memberships, revocation, and stale role-version checks keep working unchanged.

Tests (required):

- New verified user → first protected request returns 200, exactly one user + one BUYER membership in the judge tenant.
- Flag off → 403 `user_not_provisioned` as before.
- M2M token → no JIT, existing behavior.
- Two concurrent first requests → one user, one membership.
- JIT user cannot call merchant/judge routes (403).
- JIT never creates a membership in the dev tenant when the judge tenant exists.
- Revoked membership is not re-created by JIT.
- Rate limit over threshold → 429.

## Part 2 — Pre-made judge account

Extend `pnpm auth:provision-judge-user` (from 04) to assign BUYER + MERCHANT (or SCHEDULER) + JUDGE in the judge tenant only. Give the user exact Auth0 steps to create the user `judge@<team domain or plus-address>` with a password that satisfies the policy. Credentials go only in the Devpost testing instructions.

## Part 3 — Auth0 tenant settings (give the user exact click-by-click steps)

1. Authentication → Database → Username-Password-Authentication:
   - "Disable Sign Ups" OFF (sign ups allowed).
   - Password policy: "Fair" or "Good" with minimum length 10 (judges should not fight the policy). Keep "no personal info" and "password dictionary" checks on.
   - Applications tab: velvetAI Web enabled.
2. Optional but recommended — Authentication → Social → Google:
   - Use your own Google OAuth client (Google Cloud Console → APIs & Services → Credentials → OAuth client ID → Web application → Authorized redirect URI `https://dev-ru8k002bt7vgmtj5.us.auth0.com/login/callback`). Paste Client ID and Secret into Auth0 (the user does this; never in chat). Do not rely on Auth0 development keys for the judging period.
   - Applications tab: enable for velvetAI Web.
3. Branding → Universal Login: set the application logo and the "velvetAI" name so the login page looks like part of the product (optional, 5 minutes).
4. velvetAI Web → Settings: Application Login URI not required; confirm the hosted Render web URL is in callback/logout/web origins (done in 03).

## Part 4 — Public read-only access (API)

Make these routes work without a token, scoped to the demo/judge tenant, read-only, rate-limited (60/min per IP), with no PII:

- `GET /v1/services`, `GET /v1/availability` (if not already public) for the public demo tenant.
- `GET /v1/merchant/schedule` in a `public=true` read-only mode for the judge tenant only: masked buyer labels ("Guest A.K." / "Demo guest 07"), no notes, no PayPal ids, no proof links. (Track B renders it in 05.)
- `/security` data is a static JSON file (07), no API needed.

Everything that mutates (holds, approval, payment, race test, reset, fault injection) still requires login and the right role.

Tests: unauthenticated public reads return 200 with masked data; unauthenticated mutations return 401; public schedule never returns another tenant's data.

## Part 5 — UI items (Track B implements these in 05; Track A only provides the API)

- Navbar: "Sign in or create account" button (Auth0 `loginWithRedirect` with `screen_hint` left default so both tabs show; returnTo current page).
- First-run welcome card after the first successful login (localStorage flag): "Welcome — you can now book with Ask AI. Paying uses PayPal Sandbox: use the sandbox buyer from the Devpost testing instructions."
- Ask AI drawer when signed out: show a short explanation and the sign-in button instead of an error.
- `/schedule` signed out: read-only demo view with the banner "Demo schedule (read-only). Sign in to book or run the race test."
- 403 `user_not_provisioned` should no longer appear for judges; if it does (flag off), show "Your account isn't set up yet" with a retry button, never a raw error.

## Definition of done

- [ ] JIT provisioning with all tests passing; flag documented in docs/DEPLOYMENT.md and set on Render.
- [ ] Judge account provisioned on Render with judge + merchant + buyer roles.
- [ ] Auth0 signup on, password policy friendlier, Google optional.
- [ ] Public read-only routes with masking and tests.
- [ ] Manual hosted test: a brand-new email signs up on the hosted site, lands back on the page, Ask AI works, prepares a hold, approves, pays with the sandbox buyer, sees Confirmed — no manual CLI step.
- [ ] Checklist row "Judge self-service access" added to docs/epic5-checklist.md.
