# velvetAI Zero-Cost (No-Card) Hosting Runbook

> **Cost profile: \$0/month, no credit card required.**
>
> - **Database:** Neon Free PostgreSQL 17 ([Neon Postgres](https://neon.com))
> - **API + In-Process Worker:** 1 × Render Free Web Service (Docker) ([Render Free Tier](https://render.com/docs/free))
> - **Frontend SPA:** Render Free Static Site _or_ Vercel Hobby (`https://velvetai-five.vercel.app`) ([Render Static Sites](https://render.com/docs/static-sites))
> - **Keep-Warm Ping:** UptimeRobot Free 5-minute HTTP monitor (`GET /health/live`)

> [!IMPORTANT]
> This guide requires **no Render Blueprint (`render.yaml`) apply** and **no Render paid PostgreSQL**. All database DDL migrations (`MIGRATE_ON_START=true`) and background loops (`RUN_WORKER_IN_PROCESS=true`: outbox relay, hold reaper, and PayPal reconciliation) run cleanly inside the single Render Free API container.

---

## 1. Architecture & Why It Works on Free Tiers

```text
+-----------------------------------+        HTTPS + CORS         +------------------------------------------+
|  Frontend SPA (Always Free CDN)   | --------------------------> |  velvetai-api (1x Render Free Docker)    |
|  Render Static Site  OR  Vercel   |                             |  - Fastify 5 REST + MCP + Ask AI (Gemini)|
+-----------------------------------+                             |  - MIGRATE_ON_START=true (advisory lock) |
                                                                  |  - RUN_WORKER_IN_PROCESS=true            |
+-----------------------------------+   5-min ping /health/live   |    (outbox + hold reaper + reconcile)    |
|  UptimeRobot Free Monitor         | --------------------------> +-------------------+----------------------+
+-----------------------------------+                                                 |
                                                                                      | PostgreSQL 17 TLS
                                                                                      | (sslmode=require)
                                                                                      v
+-----------------------------------+    HTTPS Orders/Webhooks    +------------------------------------------+
|  PayPal Sandbox + Auth0 Tenant    | <-------------------------> |  Neon Free PostgreSQL 17                 |
+-----------------------------------+                             |  - Pooled URL (-pooler) -> DATABASE_URL  |
                                                                  |  - Direct URL          -> MIGRATION_URL  |
                                                                  +------------------------------------------+
```

### Neon PostgreSQL Specifics

Per the official Neon documentation ([Extensions](https://neon.com/docs/extensions/pg-extensions), [Manage Roles](https://neon.com/docs/manage/roles), [Connection Pooling](https://neon.com/docs/connect/connection-pooling)):

1. **`btree_gist` extension is supported**: `CREATE EXTENSION IF NOT EXISTS btree_gist;` works natively on Neon using the default branch owner role (`neondb_owner`).
2. **Create `velvet_runtime` via SQL, not the Neon Console UI**: Roles created through the Neon Console UI/CLI automatically inherit `neon_superuser` (which grants `BYPASSRLS`). Running [`scripts/neon-db-bootstrap.sql`](../scripts/neon-db-bootstrap.sql) via SQL creates `velvet_runtime` with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` and zero `neon_superuser` membership so PostgreSQL `FORCE ROW LEVEL SECURITY` stays strictly enforced.
3. **`sslmode=require` TLS enforcement**: Neon requires TLS (`?sslmode=require`). [`parseSslConfig`](../packages/db/src/client.ts) enables `{ rejectUnauthorized: false }` automatically for `sslmode=require` and non-local hostnames.
4. **Pooled vs Direct connection strings**:
   - **`DATABASE_URL` (runtime API + worker):** Use Neon's **pooled** connection string (`ep-...-pooler.<region>.aws.neon.tech/...?sslmode=require`) as `velvet_runtime`. PgBouncer transaction pooling works seamlessly with velvetAI because all tenant scoping uses transaction-local `set_config('app.tenant_id', ..., true)` and all worker claims use row-level `FOR UPDATE SKIP LOCKED` + lease tokens.
   - **`DATABASE_MIGRATION_URL` (startup migrations + bootstrap):** Use Neon's **direct (unpooled)** connection string (`ep-...<region>.aws.neon.tech/...?sslmode=require` without `-pooler`) as `neondb_owner`. Required because `MIGRATE_ON_START=true` holds a session-level PostgreSQL `pg_advisory_lock` across `migrateToLatest`, which is not supported over PgBouncer transaction pooling.

### Render Free Web Service Specifics

Per Render's official documentation ([Free Plan](https://render.com/docs/free), [Web Services](https://render.com/docs/web-services), [Static Sites](https://render.com/docs/static-sites)):

1. **Inactivity spin-down (~15 min):** Free Web Services spin down after 15 minutes without inbound HTTP traffic (with ~60s cold start on the next request). Setting up a free 5-minute uptime monitor on `GET /health/live` prevents idle sleep during judging windows.
2. **750 free instance hours/month:** Render provides **750 free web-service hours per month** per workspace. Because a calendar month has at most 744 hours, running **one** always-warm free API web service fits within the free monthly allowance without a card. Running two separate always-on services would double-consume hours and exhaust the quota mid-month, which is why the worker runs via `RUN_WORKER_IN_PROCESS=true` (`EMBED` replacement; defaults to `false`).
3. **`PORT` handling:** Render automatically injects `PORT=10000` into Web Services. [`server.ts`](../apps/api/src/server.ts) binds to `env.HOST` (`0.0.0.0`) and `env.PORT` (`process.env.PORT`), and [`Dockerfile.api`](../Dockerfile.api) healthchecks dynamically inspect `${PORT:-3000}`.
4. **Static Sites are always free:** Render Static Sites serve from global CDN with zero hour quota and never spin down.

---

## 2. Step-by-Step Setup (Zero Card)

### Step 1: Provision Neon Free PostgreSQL 17 & Bootstrap `velvet_runtime`

1. Sign in to [Neon Console](https://console.neon.tech) and click **Create project**:
   - **Postgres version:** `17`
   - **Plan:** `Free`
   - **Database name:** `neondb` (or keep default)
   - Choose the region closest to your Render workspace (e.g., **US East (Ohio)** / `aws-us-east-2` or **US East (N. Virginia)**).
2. Open the project **Dashboard** → click **Connect**:
   - Toggle **Connection pooling: OFF** → copy the **Direct connection string** (`NEON_DIRECT_OWNER_URL`):
     `postgresql://neondb_owner:<OWNER_PASS>@ep-<id>.<region>.aws.neon.tech/neondb?sslmode=require`
   - Toggle **Connection pooling: ON** → copy the **Pooled host** (`ep-<id>-pooler.<region>.aws.neon.tech`) so you can construct the `velvet_runtime` URL right after running the bootstrap SQL.
3. In your local terminal, run [`scripts/neon-db-bootstrap.sql`](../scripts/neon-db-bootstrap.sql) using `read -s` so neither your Neon password nor `velvet_runtime` password enters shell history:

```zsh
read -s "NEON_DIRECT_URL?Neon direct owner URL: "
echo ""
read -s "RUNTIME_PASS?Choose a strong password for velvet_runtime: "
echo ""

psql "$NEON_DIRECT_URL" -v runtime_password="$RUNTIME_PASS" -f scripts/neon-db-bootstrap.sql

unset NEON_DIRECT_URL RUNTIME_PASS
```

4. Confirm the SQL output prints:
   - `btree_gist` under `pg_extension`
   - `velvet_runtime | rolsuper=f | rolbypassrls=f | rolcanlogin=t`
   - `member_of_groups | {}` (must NOT contain `neon_superuser`)
5. Construct your runtime `DATABASE_URL` by swapping the user/password onto the **pooled** Neon hostname:
   ```text
   postgresql://velvet_runtime:<RUNTIME_PASS>@ep-<id>-pooler.<region>.aws.neon.tech/neondb?sslmode=require
   ```

---

### Step 2: Generate Local Signing & Encryption Secrets

Run these 3 commands locally and keep the outputs handy for Step 3 (never commit them):

```zsh
# 1. INTENT_SIGNING_KEY (ES256 / P-256 PKCS#8 private key as base64)
node -e 'console.log(Buffer.from(require("node:crypto").generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"))'

# 2. CONFIRMATION_TOKEN_SECRET (64 hex chars / 32 bytes)
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'

# 3. ENVELOPE_ENCRYPTION_KEY (64 hex chars / 32 bytes)
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

---

### Step 3: Deploy `velvetai-api` (Render Free Docker Web Service)

1. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Web Service**.
2. Connect repository **`AyuK03/velvetAI`**, branch **`main`**.
3. Configure service settings:
   - **Name:** `velvetai-api` (note any random suffix Render assigns, e.g., `velvetai-api-xxxx.onrender.com`)
   - **Language / Runtime:** `Docker`
   - **Region:** Closest to your Neon region (e.g., Ohio / Virginia)
   - **Branch:** `main`
   - **Dockerfile Path:** `./Dockerfile.api`
   - **Instance Type:** `Free` ($0/month)
4. Expand **Advanced** → set **Health Check Path:** `/health/ready` (or `/health/live`).
5. Add **every environment variable** from the table below before clicking **Create Web Service**:

#### Env Table: `velvetai-api`

| Variable                       |   Secret   | Value / Source                                                               |         Needed at 1st Deploy?          |
| :----------------------------- | :--------: | :--------------------------------------------------------------------------- | :------------------------------------: |
| `NODE_ENV`                     | NOT SECRET | `production`                                                                 |                  Yes                   |
| `PORT`                         | NOT SECRET | Injected by Render (`10000`) or `10000`                                      |               Auto / Yes               |
| `HOST`                         | NOT SECRET | `0.0.0.0` (default)                                                          |                Optional                |
| `DATABASE_URL`                 | **SECRET** | Neon **pooled** `velvet_runtime` URI (`...-pooler...?sslmode=require`)       |                **Yes**                 |
| `DATABASE_MIGRATION_URL`       | **SECRET** | Neon **direct** `neondb_owner` URI (`?sslmode=require`)                      |                **Yes**                 |
| `MIGRATE_ON_START`             | NOT SECRET | `true` (default in code is `false`)                                          |                **Yes**                 |
| `RUN_WORKER_IN_PROCESS`        | NOT SECRET | `true` (default in code is `false`)                                          |                **Yes**                 |
| `OIDC_MOCK_ENABLED`            | NOT SECRET | `false`                                                                      |                **Yes**                 |
| `AUTH0_ISSUER`                 | NOT SECRET | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/`                                 |                **Yes**                 |
| `AUTH0_AUDIENCE`               | NOT SECRET | `https://velvetai.example/api`                                               |                **Yes**                 |
| `AUTH0_JWKS_URI`               | NOT SECRET | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/.well-known/jwks.json`            | Optional (derived from `AUTH0_ISSUER`) |
| `OIDC_ISSUER`                  | NOT SECRET | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/`                                 |                  Yes                   |
| `OIDC_AUDIENCE`                | NOT SECRET | `https://velvetai.example/api`                                               |                  Yes                   |
| `MCP_RESOURCE_URL`             | NOT SECRET | `https://<api-host>.onrender.com/mcp`                                        |  Yes (update with actual Render host)  |
| `PUBLIC_WEB_ORIGIN`            | NOT SECRET | `https://<web-host>.onrender.com` (or `https://velvetai-five.vercel.app`)    |                  Yes                   |
| `ALLOWED_ORIGINS`              | NOT SECRET | `https://<web-host>.onrender.com` (comma-separated if supporting Vercel too) |                  Yes                   |
| `ALLOWED_HOSTS`                | NOT SECRET | `<api-host>.onrender.com` (hostname only, no `https://`)                     |                  Yes                   |
| `WEB_BASE_URL`                 | NOT SECRET | `https://<web-host>.onrender.com` (or Vercel URL)                            |                  Yes                   |
| `API_BASE_URL`                 | NOT SECRET | `https://<api-host>.onrender.com`                                            |                  Yes                   |
| `SELF_SIGNUP_ENABLED`          | NOT SECRET | `true`                                                                       |                **Yes**                 |
| `SELF_SIGNUP_TENANT_ID`        | NOT SECRET | `01932b10-0000-7000-8000-000000000a01`                                       |                **Yes**                 |
| `PUBLIC_DEMO_TENANT_ID`        | NOT SECRET | `01932b10-0000-7000-8000-000000000a01`                                       |                **Yes**                 |
| `AI_PROVIDER`                  | NOT SECRET | `gemini`                                                                     |                **Yes**                 |
| `AI_MODEL`                     | NOT SECRET | `gemini-3.5-flash-lite`                                                      |                **Yes**                 |
| `AI_DAILY_TURN_BUDGET`         | NOT SECRET | `1500`                                                                       |                  Yes                   |
| `GOOGLE_GENERATIVE_AI_API_KEY` | **SECRET** | Gemini API key from Google AI Studio                                         |                **Yes**                 |
| `INTENT_SIGNING_KEY`           | **SECRET** | Base64 ES256 PKCS#8 PEM from Step 2                                          |                **Yes**                 |
| `CONFIRMATION_TOKEN_SECRET`    | **SECRET** | 64-char hex secret from Step 2                                               |                **Yes**                 |
| `ENVELOPE_ENCRYPTION_KEY`      | **SECRET** | 64-char hex key from Step 2                                                  |                **Yes**                 |
| `PAYPAL_ENVIRONMENT`           | NOT SECRET | `sandbox`                                                                    |                **Yes**                 |
| `PAYPAL_CLIENT_ID`             | **SECRET** | PayPal Sandbox App Client ID                                                 |                **Yes**                 |
| `PAYPAL_CLIENT_SECRET`         | **SECRET** | PayPal Sandbox App Secret                                                    |                **Yes**                 |
| `PAYPAL_WEBHOOK_ID`            | **SECRET** | Temporary `WH-SANDBOX-DEFAULT` (replace in Step 7)                           |                **Yes**                 |

6. Click **Deploy Web Service**. On boot, logs should show:
   - Startup migrations 0001–0009 completing under the PostgreSQL advisory lock
   - `[in-process-worker] Outbox relay, hold reaper, and reconciliation loop active in API process`
   - `velvetAI API running at http://0.0.0.0:10000`
7. Copy your assigned API URL (`https://<api-host>.onrender.com`), update `MCP_RESOURCE_URL`, `ALLOWED_HOSTS`, `API_BASE_URL` if a suffix was added, and save.

---

### Step 4A: Deploy `velvetai-web` (Render Free Static Site)

> Use **Step 4B** instead if you are using your teammate's existing Vercel deployment at `velvetai-five.vercel.app`.

1. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Static Site**.
2. Connect repository **`AyuK03/velvetAI`**, branch **`main`**.
3. Configure build settings:
   - **Name:** `velvetai-web`
   - **Branch:** `main`
   - **Build Command:** `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @velvetai/web build`
   - **Publish Directory:** `apps/web/dist`
4. Under **Environment** add:

#### Env Table: `velvetai-web` (Static Site)

| Variable                |   Secret   | Value / Source                                                 |       Needed at 1st Deploy?        |
| :---------------------- | :--------: | :------------------------------------------------------------- | :--------------------------------: |
| `NODE_VERSION`          | NOT SECRET | `24`                                                           |                Yes                 |
| `VITE_API_BASE_URL`     | NOT SECRET | `https://<api-host>.onrender.com`                              | **Yes** (baked at Vite build time) |
| `VITE_AUTH0_DOMAIN`     | NOT SECRET | `dev-ru8k002bt7vgmtj5.us.auth0.com`                            |              **Yes**               |
| `VITE_AUTH0_CLIENT_ID`  | NOT SECRET | `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`                             |              **Yes**               |
| `VITE_AUTH0_AUDIENCE`   | NOT SECRET | `https://velvetai.example/api`                                 |              **Yes**               |
| `VITE_PAYPAL_CLIENT_ID` | NOT SECRET | PayPal Sandbox App Client ID (public browser SDK v6 client id) |              **Yes**               |

5. After creation, open **`velvetai-web`** → **Redirects/Rewrites** → **Add Rule**:
   - **Source:** `/*`
   - **Destination:** `/index.html`
   - **Action:** `Rewrite`
6. Open **`velvetai-web`** → **Headers** → add 4 security headers for Path `/*`:
   - `X-Frame-Options`: `DENY`
   - `Content-Security-Policy`: `frame-ancestors 'none'`
   - `X-Content-Type-Options`: `nosniff`
   - `Referrer-Policy`: `strict-origin-when-cross-origin`
7. Note your final Static Site origin (`https://<web-host>.onrender.com`) and verify `PUBLIC_WEB_ORIGIN`, `ALLOWED_ORIGINS`, and `WEB_BASE_URL` on `velvetai-api` match it, then trigger **Deploy latest commit** on the API if updated.

---

### Step 4B (Alternative): Existing Vercel Frontend (`velvetai-five.vercel.app`) + Render API

If your frontend runs on Vercel (`https://velvetai-five.vercel.app`) instead of a Render Static Site:

1. Root [`vercel.json`](../vercel.json) (used when Vercel root directory is `.`) and [`apps/web/vercel.json`](../apps/web/vercel.json) (used if root directory is `apps/web`) are already committed in the repository and provide:
   - Vite framework + `pnpm turbo run build --filter=@velvetai/web`
   - SPA rewrite: `/(.*) -> /index.html`
   - Response headers: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`
2. In Vercel **Project Settings → Environment Variables** (Production), set:

| Variable                |   Secret   | Value                               |
| :---------------------- | :--------: | :---------------------------------- |
| `VITE_API_BASE_URL`     | NOT SECRET | `https://<api-host>.onrender.com`   |
| `VITE_AUTH0_DOMAIN`     | NOT SECRET | `dev-ru8k002bt7vgmtj5.us.auth0.com` |
| `VITE_AUTH0_CLIENT_ID`  | NOT SECRET | `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`  |
| `VITE_AUTH0_AUDIENCE`   | NOT SECRET | `https://velvetai.example/api`      |
| `VITE_PAYPAL_CLIENT_ID` | NOT SECRET | PayPal Sandbox Client ID            |

3. Trigger a fresh Vercel **Redeploy** with build cache cleared (`Vite` bakes `VITE_*` variables into the bundle).
4. On **`velvetai-api`** in Render, set `PUBLIC_WEB_ORIGIN=https://velvetai-five.vercel.app`, `WEB_BASE_URL=https://velvetai-five.vercel.app`, and `ALLOWED_ORIGINS=https://velvetai-five.vercel.app` (or comma-separated with your Render Static Site URL).

---

### Step 5: Keep the Free API Warm with UptimeRobot (No Cold Starts)

1. Sign up for a free [UptimeRobot](https://uptimerobot.com) account (no card required).
2. Click **Add New Monitor**:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `velvetai-api health`
   - **URL:** `https://<api-host>.onrender.com/health/live`
   - **Monitoring Interval:** `5 minutes`
3. This keeps inbound traffic flowing every 5 minutes (well under Render's 15-minute idle threshold) using `/health/live` while staying within Render's 750 free monthly hours for a single service.

---

### Step 6: Auth0 Configuration (`dev-ru8k002bt7vgmtj5`)

1. Open [Auth0 Dashboard](https://manage.auth0.com) (tenant `dev-ru8k002bt7vgmtj5`):
   - **Applications → velvetAI Web** (`UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`) → **Settings**:
     - **Allowed Callback URLs:** `https://<web-host>.onrender.com, https://<web-host>.onrender.com/callback, https://velvetai-five.vercel.app, https://velvetai-five.vercel.app/callback, http://localhost:5173, http://localhost:5173/callback`
     - **Allowed Logout URLs:** `https://<web-host>.onrender.com, https://velvetai-five.vercel.app, http://localhost:5173`
     - **Allowed Web Origins:** `https://<web-host>.onrender.com, https://velvetai-five.vercel.app, http://localhost:5173`
     - Save changes.
2. **Applications → APIs → + Create API**:
   - **Name:** `velvetAI MCP (Hosted)`
   - **Identifier:** `https://<api-host>.onrender.com/mcp` (must equal `MCP_RESOURCE_URL`)
   - **Signing Algorithm:** `RS256`
   - Under **Permissions**, add: `booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`.
3. **Applications → velvetAI MCP Agent** (`ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut`) → **API Access**:
   - Authorize **`velvetAI MCP (Hosted)`** under Client Access with all 4 scopes (`4/4`).

---

### Step 7: PayPal Sandbox Webhook Registration

1. Open [PayPal Developer Portal → Sandbox Apps](https://developer.paypal.com/dashboard/applications/sandbox) and select your app.
2. Under **Webhooks → Add Webhook**, configure:
   - **Webhook URL:** `https://<api-host>.onrender.com/v1/webhooks/paypal/default`
     _(Matches [`webhookRoutes`](../apps/api/src/routes/payments.ts) `POST /v1/webhooks/paypal/:connectionKey`.)_
   - **Event Types (select all 6):**
     - `CHECKOUT.ORDER.APPROVED`
     - `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
     - `PAYMENT.CAPTURE.COMPLETED`
     - `PAYMENT.CAPTURE.PENDING`
     - `PAYMENT.CAPTURE.DENIED`
     - `PAYMENT.CAPTURE.REFUNDED`
3. Save and copy the generated **Webhook ID** (`WH-...`).
4. In Render Dashboard → `velvetai-api` → **Environment**, replace temporary `PAYPAL_WEBHOOK_ID` with the real Webhook ID and redeploy `velvetai-api`.

---

### Step 8: Hosted Database Seed & Judge/Buyer Provisioning

Run locally using `read -s` so Neon URLs never enter shell history (`NEON_DIRECT_OWNER_URL` is used for `judge:provision` owner seed, and `NEON_POOLED_RUNTIME_URL` or `NEON_DIRECT_URL` with `ALLOW_HOSTED_SEED=1`):

```zsh
read -s "NEON_DIRECT_URL?Neon direct owner URL: "
echo ""
read -s "NEON_RUNTIME_URL?Neon pooled velvet_runtime URL: "
echo ""

# 1. Seed & forecast Judge Tenant (01932b10-0000-7000-8000-000000000a01)
DATABASE_MIGRATION_URL="$NEON_DIRECT_URL" ALLOW_JUDGE_PROVISION=1 pnpm judge:provision

# 2. Provision Demo Judge Auth0 account in Judge Tenant (role: JUDGE)
DATABASE_URL="$NEON_RUNTIME_URL" ALLOW_HOSTED_SEED=1 pnpm auth:provision-judge-user

# 3. Seed synthetic dev tenant catalog (01932b10-0000-7000-8000-000000000001) + M2M agent
DATABASE_URL="$NEON_RUNTIME_URL" ALLOW_HOSTED_SEED=1 pnpm dev:catalog:confirm
DATABASE_URL="$NEON_RUNTIME_URL" ALLOW_HOSTED_SEED=1 AUTH0_AGENT_CLIENT_ID="ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut" pnpm auth:provision-agent-client

unset NEON_DIRECT_URL NEON_RUNTIME_URL
```

---

## 3. Hosted Verification Checklist

Run after completing Steps 1–8:

```zsh
# 1. API liveness and readiness
curl -fsS https://<api-host>.onrender.com/health/live
curl -fsS https://<api-host>.onrender.com/health/ready

# 2. OAuth Protected Resource Metadata (RFC 9728)
curl -fsS https://<api-host>.onrender.com/.well-known/oauth-protected-resource
curl -fsS https://<api-host>.onrender.com/.well-known/oauth-protected-resource/mcp

# 3. Public Judge-Tenant catalog & availability reads (unauthenticated)
curl -fsS https://<api-host>.onrender.com/v1/services
curl -fsS "https://<api-host>.onrender.com/v1/availability?serviceId=<SERVICE_ID>&date=2026-11-15"

# 4. Restricted role & FORCE ROW LEVEL SECURITY check against Neon
read -s "NEON_RUNTIME_URL?Neon pooled velvet_runtime URL: "
echo ""
DATABASE_URL="$NEON_RUNTIME_URL" pnpm tsx scripts/hosted-rls-check.ts
unset NEON_RUNTIME_URL

# 5. End-to-end MCP client smoke test
API_BASE_URL="https://<api-host>.onrender.com" PUBLIC_WEB_ORIGIN="https://<web-host>.onrender.com" pnpm mcp:smoke
```

In your browser:

1. Visit `https://<web-host>.onrender.com/security` **unauthenticated** → confirm CI report (`51 of 51 passed`) renders publicly and live run panel prompts `"Sign in as the demo judge to run live checks"`.
2. Sign in with the provisioned **Demo Judge** account on `/security` → click **Run live checks** → confirm all live checks pass with `State changed: none`.
3. Sign in with a fresh test user (JIT buyer provisioning in Judge Tenant) → verify `/book` and Ask AI complete a quote → prepare → human approval link → PayPal sandbox capture cleanly.
