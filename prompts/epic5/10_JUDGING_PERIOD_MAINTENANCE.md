# Epic 5 · Work Package 10 — Judging-Period Maintenance (Nov 10 – Dec 15)

Priority: P0 · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

Keep the submitted demo working, free, and unchanged in substance until judging ends on Tue Dec 15, 2026, 8:00 AM Pacific.

## Rules during judging

1. The deployed code is the tagged `devpost-submission-v1` commit. Do not deploy new features.
2. Only critical fixes are allowed (site down, login broken, payment flow broken, security issue). Each fix: smallest possible change, full verification set, new tag `devpost-submission-v1.N`, note in `docs/submission/CHANGELOG_JUDGING.md` with the reason.
3. Never rotate secrets in a way that breaks the demo without immediately updating Render env vars and re-verifying.
4. Never delete the judge Auth0 user, the PayPal sandbox app, or the webhook.

## Health check script

Create `scripts/hosted-health-check.ts` (`pnpm hosted:check`) that checks, without secrets:

1. Web root returns 200 and contains the app title.
2. API `/health/live` and `/health/ready` return 200.
3. `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` return valid JSON with expected resource URLs.
4. `GET /v1/ai/status` reports provider gemini and `realProviderConfigured: true`.
5. `POST /mcp` without a token returns 401 with `WWW-Authenticate`.
6. Prints PASS/FAIL per check and exits non-zero on any failure.

Optionally add a scheduled GitHub Action (every 6 hours) that runs it and opens an issue on failure. No secrets needed.

## Twice-weekly manual check (user, about 10 minutes)

1. `pnpm hosted:check`.
2. Sign in as the judge on the hosted site, reset demo, run one booking through PayPal Sandbox, run live security checks.
3. Check Render dashboard: services healthy, credit balance, database storage.
4. Check Google AI Studio: quota usage for the Gemini key.
5. Check Bryntum: watermark still shows trial, scheduler still loads (trial not expired). If expiry is near, switch to the backup account per the team plan and redeploy with no code change other than what Bryntum requires.

## Expiry calendar

Copy the table from `docs/submission/DEADLINES.md` and set phone reminders 7 days before each expiry.

## If something breaks

1. Run `pnpm hosted:check` and read Render logs for the failing service.
2. Common causes and fixes:
   - Gemini quota exhausted: wait for reset or enable billing with a budget cap; the UI already shows a friendly message.
   - Render credits exhausted: add a payment method or reduce plan sizes only if the database plan stays non-expiring.
   - PayPal webhook failing: check the webhook ID env var and the PayPal dashboard delivery log.
   - Auth0 login failing: check callback URLs and that the judge user is not blocked.
   - Bryntum trial expired: switch account/trial per team plan.
3. Fix with the smallest change, follow rule 2 above.
