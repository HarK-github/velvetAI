# Epic 5 · Work Package 03 — Hosted Deployment on Render

Priority: P0 · Time box: 2 days · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

A stable public deployment that judges can use until Dec 15:

```text
https://<web>.onrender.com        React SPA (static site)
https://<api>.onrender.com        Fastify API (+ /mcp, /v1/ai/chat, webhooks)
background worker                  outbox relay, hold reaper, reconciliation
managed PostgreSQL                 with btree_gist, RLS, restricted runtime role
```

Then repeat the real PayPal Sandbox end-to-end test against the hosted URLs with a stable webhook.

Deploying early matters: hosting problems found on Nov 9 cannot be fixed in time.

## Preconditions

1. WP 02 VERIFIED (or at least its API routes merged; the page can still be in progress).
2. Ask the user to confirm in chat (yes/no only, no codes or billing details):
   - Render account exists, GitHub connected, MFA on.
   - Workspace "velvetAI Hackathon" exists and hackathon credits are applied to it.
   - The velvetAI GitHub repository is visible to Render.
   - Whether the GitHub repository is public yet (it must be public before submission; it may stay private during development if Render has access).
3. Read the current official docs before editing (do not rely on memory):
   - Blueprint spec: https://render.com/docs/blueprint-spec
   - Static sites (redirects/rewrites, headers): https://render.com/docs/static-sites
   - Free tier limits: https://render.com/docs/free
   - PostgreSQL extensions: https://render.com/docs/postgresql-extensions
   - Monorepo support / root directory and build filters: https://render.com/docs/monorepo-support
     Report any field in the current `render.yaml` that does not exist in the current spec.

## Plan and instance type decision

Things to verify in the Render docs and report back. As of this writing they are believed true:

- Free PostgreSQL databases expire after a limited period (about 30 days). Judging ends Dec 15, so the database must be a paid plan.
- Free web services sleep after inactivity and cold start slowly. Judges will see a broken demo. Use a paid instance.
- Background workers have no free plan.
- `preDeployCommand` is available only on paid instance types.

Therefore use the smallest paid instance types for API, worker, and PostgreSQL, funded by credits. The static site is free. Estimate the monthly cost from the Render pricing page and compare with the credit amount the user reports. Write the estimate into `docs/submission/DEADLINES.md`.

If credits are insufficient for API + worker + DB until Dec 15, STOP and tell the user the options (for example run the worker inside the API process as a fallback mode guarded by an env flag). Do not decide alone.

## Tasks

### 1. render.yaml

Rewrite `render.yaml` to match the current spec. Structure (field names must be verified against the docs):

```yaml
databases:
  - name: velvetai-db
    plan: <smallest paid plan name from docs>
    postgresMajorVersion: "17" # verify supported versions; use 17 if available
    databaseName: velvetai
    user: velvetai_owner
    ipAllowList: [] # only Render private network; verify syntax

envVarGroups:
  - name: velvetai-sandbox-secrets
    envVars:
      - key: PAYPAL_ENVIRONMENT
        value: sandbox
      - key: PAYPAL_CLIENT_ID
        sync: false
      - key: PAYPAL_CLIENT_SECRET
        sync: false
      - key: PAYPAL_WEBHOOK_ID
        sync: false
      - key: GOOGLE_GENERATIVE_AI_API_KEY
        sync: false
      - key: INTENT_SIGNING_KEY
        sync: false
      - key: CONFIRMATION_TOKEN_SECRET
        sync: false
      - key: ENVELOPE_ENCRYPTION_KEY
        sync: false

services:
  - type: web
    name: velvetai-api
    runtime: docker
    dockerfilePath: ./Dockerfile.api
    plan: <smallest paid>
    healthCheckPath: /health/ready # use whatever path the API really serves; check routes
    preDeployCommand: <migration command that works inside the API image>
    envVars:
      - fromGroup: velvetai-sandbox-secrets
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL # runtime role URL; see task 3
        sync: false
      - key: DATABASE_MIGRATION_URL
        fromDatabase:
          name: velvetai-db
          property: connectionString
      - key: AUTH0_ISSUER
        sync: false
      - key: AUTH0_AUDIENCE
        sync: false
      - key: MCP_RESOURCE_URL
        sync: false
      - key: PUBLIC_WEB_ORIGIN
        sync: false
      - key: ALLOWED_ORIGINS
        sync: false
      - key: ALLOWED_HOSTS
        sync: false
      - key: AI_PROVIDER
        value: gemini
      - key: AI_MODEL
        value: gemini-3.5-flash-lite

  - type: worker
    name: velvetai-worker
    runtime: docker
    dockerfilePath: ./Dockerfile.worker
    plan: <smallest paid>
    envVars:
      - fromGroup: velvetai-sandbox-secrets
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false

  - type: web
    name: velvetai-web
    runtime: static
    buildCommand: corepack enable && pnpm install --frozen-lockfile && pnpm --filter @velvetai/web build
    staticPublishPath: ./apps/web/dist
    routes:
      - type: rewrite
        source: /*
        destination: /index.html
    headers:
      - path: /*
        name: X-Frame-Options
        value: DENY
      - path: /*
        name: Content-Security-Policy
        value: frame-ancestors 'none'
      - path: /*
        name: X-Content-Type-Options
        value: nosniff
      - path: /*
        name: Referrer-Policy
        value: strict-origin-when-cross-origin
    envVars:
      - key: NODE_VERSION
        value: "24"
      - key: VITE_API_BASE_URL
        sync: false
      - key: VITE_AUTH0_DOMAIN
        sync: false
      - key: VITE_AUTH0_CLIENT_ID
        sync: false
      - key: VITE_AUTH0_AUDIENCE
        sync: false
      - key: VITE_PAYPAL_CLIENT_ID
        sync: false
```

Rules:

- No secret values in the file. `sync: false` means the user enters the value in the dashboard.
- Verify the pnpm version required by `packageManager` works with corepack on Render's Node 24 image. If the static build fails because of pnpm, use the exact fix from the build log and Render docs; report it.
- Verify the Dockerfiles build locally first: `docker build -f Dockerfile.api .` and `docker build -f Dockerfile.worker .`.
- The CSP header on the static site must not break Auth0 or the PayPal SDK. Only add `frame-ancestors 'none'` now; do not add a full CSP script policy unless you test Auth0 login and the PayPal popup with it.

### 2. Database bootstrap (first deploy)

Write `scripts/render-db-bootstrap.sql` (or a TS script) that the user runs ONCE using the Render dashboard's external connection (PSQL command) as the owner:

1. `CREATE EXTENSION IF NOT EXISTS btree_gist;` (if migrations do not already do it).
2. Create the restricted runtime role if Render allows it:

```sql
-- password is supplied by the user at run time via psql variable, never committed
CREATE ROLE velvet_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
```

Grants follow exactly the same grants the local migrations/test setup give the runtime role (copy them; do not invent).

3. Verification queries the user runs and pastes back (no secrets in output):

```sql
SELECT version();
SELECT extname FROM pg_extension WHERE extname = 'btree_gist';
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN (current_user, 'velvet_runtime');
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
```

If Render does not allow `CREATE ROLE`, STOP and report the exact error. Fallback (only with user approval): the API connects as the owner, which is not superuser; FORCE RLS still applies to owners. Prove isolation with the cross-tenant test in task 6.

Give the user exact steps: Render Dashboard → velvetai-db → Connect → External Connection → copy the PSQL command → run it in Terminal → `\i scripts/render-db-bootstrap.sql` with `-v runtime_password=...` typed locally. Then they set `DATABASE_URL` for API and worker in the dashboard to the runtime role connection string (internal URL host).

### 3. Migrations on deploy

- `preDeployCommand` runs migrations using `DATABASE_MIGRATION_URL` (owner). The app runtime uses `DATABASE_URL` (runtime role).
- Make sure the migration command exists inside the API Docker image (check the Dockerfile copies `packages/db` and its built output). Test locally: `docker run --rm -e DATABASE_MIGRATION_URL=... <image> <migration command>` against local Postgres.

### 4. Seed for hosted demo

The hosted demo uses the judge tenant (created in WP 04). Until WP 04 lands, seed the development catalog into the hosted DB with the existing `pnpm dev:catalog:confirm` adapted to accept a target tenant and to refuse running unless `ALLOW_HOSTED_SEED=1` is set explicitly. Never run seeds automatically on startup.

### 5. External dashboards (give the user exact steps; they enter values themselves)

Auth0 (velvetAI Web SPA application → Settings):

- Allowed Callback URLs: add `https://<web>.onrender.com`
- Allowed Logout URLs: add `https://<web>.onrender.com`
- Allowed Web Origins: add `https://<web>.onrender.com`
- Save.

Auth0 MCP API (from EPIC4_FINAL_FIXES F2): create another API identifier `https://<api>.onrender.com/mcp` (Auth0 API identifiers cannot be renamed). Authorize the "velvetAI MCP Agent" M2M app for it with the agent scopes. Set `MCP_RESOURCE_URL=https://<api>.onrender.com/mcp`.

PayPal Developer Dashboard (Sandbox):

1. Apps & Credentials → Sandbox → velvetAI app → Webhooks → Add Webhook.
2. URL: `https://<api>.onrender.com/v1/webhooks/paypal/<opaque-connection-key>` (get the connection key the API expects from the existing provider-connection config; generate a new random one for hosted if it's per-environment).
3. Events: `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.
4. Save, copy the Webhook ID into Render env `PAYPAL_WEBHOOK_ID`.
5. Delete old tunnel webhook registrations.

Render env values the user sets: `ALLOWED_ORIGINS=https://<web>.onrender.com`, `ALLOWED_HOSTS=<api>.onrender.com`, `PUBLIC_WEB_ORIGIN=https://<web>.onrender.com`, `VITE_API_BASE_URL=https://<api>.onrender.com`, the Auth0 values, PayPal client id (public, web) and secret (API only).

Generate new values for `INTENT_SIGNING_KEY`, `CONFIRMATION_TOKEN_SECRET`, `ENVELOPE_ENCRYPTION_KEY` for hosted (do not reuse local). Provide the exact local command to generate each (for example an existing `pnpm keys:generate` script, or `openssl` commands that match the expected format). The user pastes them into Render, not into chat.

### 6. Hosted verification

After deploy, run and report:

1. `curl -fsS https://<api>.onrender.com/health/live` and `/health/ready`.
2. `curl -fsS https://<api>.onrender.com/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`: resource values match the public URLs.
3. Cross-tenant isolation on the hosted DB: a script `scripts/hosted-rls-check.ts` that, using the runtime role URL, sets tenant A and attempts to read tenant B rows → 0 rows. Run it once; report counts only.
4. Web: sign in with Auth0 on the hosted site, open Ask AI, list services, find slots, prepare a hold, approve, pay with PayPal Sandbox buyer, see CONFIRMED.
5. Webhook: verify a `PAYMENT.CAPTURE.COMPLETED` webhook arrived at the hosted API and reached `VERIFIED` and `PROCESSED`.
6. MCP: `MCP_URL=https://<api>.onrender.com/mcp pnpm mcp:smoke` passes (approve via hosted approval page).
7. Worker: logs show the hold reaper and reconciliation loop running (report the log lines, sanitized).
8. Cold start: confirm the API does not sleep on the chosen plan (time a request after 20 minutes idle).

Write `docs/evidence/paypal-sandbox-render.md` and `docs/evidence/render-deploy.md` (URLs, commit SHA, timestamps, sanitized outputs).

### 7. Gemini protection on the public demo

Add rate limits on `POST /v1/ai/chat`:

- Per authenticated user: 10 turns per 10 minutes.
- Per IP: 30 turns per 10 minutes.
- Global daily turn budget from env `AI_DAILY_TURN_BUDGET` (default 1500).

Over-limit returns the existing safe error (`ai_quota_exceeded` or a new `ai_rate_limited`) and the drawer shows a friendly message with the retry time. Do not silently switch to the deterministic model. If a fallback is offered, it's a button "Use demo model" and the badge says "Deterministic Demo Model".

Tests for all three limits (fake clock).

### 8. Documentation

Update `docs/DEPLOYMENT.md` with the real, tested steps (not the planned ones), the env var table (name, service, secret yes/no, example placeholder), and rollback instructions (Render "Rollback" to previous deploy; migrations must be backward compatible for one deploy).

## Definition of done

- [ ] render.yaml matches the current Blueprint spec; Blueprint sync succeeds.
- [ ] API, worker, web, and DB live on paid/non-expiring plans (static site free).
- [ ] Runtime DB role is non-superuser and non-BYPASSRLS (or documented approved fallback with passing isolation check).
- [ ] Hosted golden path with real PayPal Sandbox and verified webhook done and evidenced.
- [ ] Hosted MCP smoke passes.
- [ ] Gemini rate limits implemented and tested.
- [ ] DEPLOYMENT.md and DEADLINES.md updated (credit estimate, plan names).
- [ ] Checklist item 5 and "Hosted on Render" updated.

## Cut list (if late)

Never cut hosting, webhook, or isolation checks. You may defer the cold-start timing test and the per-IP limit (keep per-user and global).
