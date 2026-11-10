# velvetAI Production Deployment Guide (Render)

This document provides the authoritative, tested deployment architecture, configuration, and runbook for velvetAI on [Render](https://render.com).

---

## 1. Architecture Topology

```
                  +---------------------------+
                  |   velvetai-web (Vercel)   |
                  |     (React 19 / Vite)     |
                  | https://velvetai-five.    |
                  |       vercel.app          |
                  +-------------+-------------+
                                |
                                v (HTTPS REST & SSE)
+------------------+     +------+--------------------+     +------------------------+
|  PayPal Sandbox  |<--->|    velvetai-api (Web)     |<--->|      velvetai-db       |
|    REST API v2   |     |  (Fastify 5 / Docker)     |     | (Managed PostgreSQL 17 |
+------------------+     | + Embedded Outbox Worker  |     |   or Neon/Supabase)    |
                         |   (Zero-Cost $0 Setup)    |     +------------------------+
                         +---------------------------+
```

1. **`velvetai-api`** (Web Service, Docker runtime, Free Tier on Render): Fastify 5 REST API, MCP 2026-07-28 endpoint (`/mcp`), Ask AI (`/v1/ai/chat` with Google Gemini & rate limiting), PayPal webhooks, and **Embedded Outbox Worker** (`EMBED_WORKER=true`).
2. **`velvetai-web`** (Vercel Hobby Tier, Free): React 19 SPA built with Vite and deployed via Vercel CLI (`https://velvetai-five.vercel.app`).
3. **`velvetai-db`** (PostgreSQL 17, Free Tier on Render or external Neon/Supabase): PostgreSQL 17 database enforcing `FORCE ROW LEVEL SECURITY`, `btree_gist` exclusion constraints, and isolated non-superuser runtime role (`velvet_runtime`).

---

## 2. Fork & Multi-Remote Git Synchronization

Render is connected via the Render GitHub App to the private fork repository **`AyuK03/velvetAI`** in the **`velvetAI Hackathon`** workspace.

To ensure every commit pushed to `main` automatically updates the deployable fork, the local repository uses dual-push remotes:

```zsh
# Verify push URLs
git remote -v
# origin  https://github.com/HarK-github/velvetAI.git (fetch)
# origin  https://github.com/HarK-github/velvetAI.git (push)
# origin  https://github.com/AyuK03/velvetAI.git (push)
```

When changes merge to `main`, running `git push origin main` pushes simultaneously to both the upstream repo and the Render deployment fork. Render automatically triggers a deployment on new commits to `main`.

---

## 3. Environment Variables Reference

### Shared Secret Group (`velvetai-sandbox-secrets`)

| Variable                       | Secret | Description                                                                            | Value / Source                                                 | Needed at 1st Deploy? |
| :----------------------------- | :----: | :------------------------------------------------------------------------------------- | :------------------------------------------------------------- | :-------------------- |
| `PAYPAL_ENVIRONMENT`           |   No   | PayPal execution mode (must be `sandbox`)                                              | `sandbox`                                                      | Yes                   |
| `PAYPAL_CLIENT_ID`             |  Yes   | PayPal REST Sandbox App Client ID                                                      | Copied from PayPal Sandbox Developer App                       | Yes                   |
| `PAYPAL_CLIENT_SECRET`         |  Yes   | PayPal REST Sandbox App Client Secret                                                  | Copied from PayPal Sandbox Developer App                       | Yes                   |
| `PAYPAL_WEBHOOK_ID`            |  Yes   | PayPal Webhook ID returned after registering webhook (safe temp: `WH-SANDBOX-DEFAULT`) | `WH-SANDBOX-DEFAULT` (replace with real ID after creating whk) | Yes (use safe temp)   |
| `GOOGLE_GENERATIVE_AI_API_KEY` |  Yes   | Google AI Studio API Key for Gemini                                                    | Secret from Google AI Studio                                   | Yes                   |
| `INTENT_SIGNING_KEY`           |  Yes   | ES256 (P-256) PKCS#8 private key as Base64 PEM (validated by `env.ts`)                 | Generated via Node `crypto.generateKeyPairSync("ec", ...)`     | Yes                   |
| `CONFIRMATION_TOKEN_SECRET`    |  Yes   | 32-byte cryptographically random hex secret (validated length >= 32)                   | 64 hex characters via `crypto.randomBytes(32).toString("hex")` | Yes                   |
| `ENVELOPE_ENCRYPTION_KEY`      |  Yes   | 32-byte field encryption hex key (validated 64 hex characters, non-dev)                | 64 hex characters via `crypto.randomBytes(32).toString("hex")` | Yes                   |

### API Web Service (`velvetai-api`)

| Variable                 | Secret | Description                                                                                 | Value / Source                                                    | Needed at 1st Deploy?           |
| :----------------------- | :----: | :------------------------------------------------------------------------------------------ | :---------------------------------------------------------------- | :------------------------------ |
| `NODE_ENV`               |   No   | Application environment                                                                     | `production`                                                      | Yes                             |
| `PORT`                   |   No   | Fastify listening port                                                                      | Automatically set by Render (`3000` default)                      | Yes                             |
| `HOST`                   |   No   | Fastify listening interface                                                                 | `0.0.0.0`                                                         | Yes                             |
| `DATABASE_MIGRATION_URL` |  Yes   | Database owner connection URI wired from database                                           | Wired automatically via `fromDatabase: { name: velvetai-db }`     | Yes (preDeploy migrations)      |
| `DATABASE_URL`           |  Yes   | Internal connection URI for restricted role `velvet_runtime` (`sslmode=require`)            | Set manually after running `scripts/render-db-bootstrap.sql`      | No (configured right after DB)  |
| `OIDC_MOCK_ENABLED`      |   No   | OIDC mock bypass toggle (strictly false in production)                                      | `false`                                                           | Yes                             |
| `AUTH0_ISSUER`           |   No   | Auth0 OIDC Issuer URL with trailing slash                                                   | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/`                      | Yes                             |
| `AUTH0_AUDIENCE`         |   No   | Auth0 API identifier for velvetAI API                                                       | `https://velvetai.example/api`                                    | Yes                             |
| `AUTH0_JWKS_URI`         |   No   | Auth0 JSON Web Key Set URI (optional, derived from issuer if omitted)                       | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/.well-known/jwks.json` | Yes                             |
| `OIDC_ISSUER`            |   No   | Fallback OIDC Issuer URL                                                                    | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/`                      | Yes                             |
| `OIDC_AUDIENCE`          |   No   | Fallback OIDC Audience                                                                      | `https://velvetai.example/api`                                    | Yes                             |
| `MCP_RESOURCE_URL`       |   No   | Auth0 Resource Identifier for Hosted MCP API                                                | `https://<api-host>.onrender.com/mcp` (initially velvetai-api...) | Yes (update if suffix assigned) |
| `PUBLIC_WEB_ORIGIN`      |   No   | Canonical origin of the frontend static site                                                | `https://<web-host>.onrender.com` (initially velvetai-web...)     | Yes (update if suffix assigned) |
| `ALLOWED_ORIGINS`        |   No   | CORS allowed origins comma-separated                                                        | `https://<web-host>.onrender.com` (initially velvetai-web...)     | Yes (update if suffix assigned) |
| `ALLOWED_HOSTS`          |   No   | Fastify trusted hostnames comma-separated (host only, no protocol)                          | `<api-host>.onrender.com` (initially velvetai-api.onrender.com)   | Yes (update if suffix assigned) |
| `AI_PROVIDER`            |   No   | Active AI model provider                                                                    | `gemini`                                                          | Yes                             |
| `AI_MODEL`               |   No   | Primary Gemini model ID                                                                     | `gemini-3.5-flash-lite`                                           | Yes                             |
| `AI_DAILY_TURN_BUDGET`   |   No   | Global daily turn budget cap for public demo                                                | `1500`                                                            | Yes                             |
| `SELF_SIGNUP_ENABLED`    |   No   | Enable JIT buyer self-service provisioning on first Auth0 login                             | `true`                                                            | Yes                             |
| `SELF_SIGNUP_TENANT_ID`  |   No   | Target tenant ID for self-signup buyers (defaults to Judge Demo Tenant)                     | `01932b10-0000-7000-8000-000000000a01`                            | Yes                             |
| `PUBLIC_DEMO_TENANT_ID`  |   No   | Default tenant ID for unauthenticated public reads (/v1/services, /v1/availability)         | `01932b10-0000-7000-8000-000000000a01`                            | Yes                             |
| `SELF_SIGNUP_ENABLED`    |   No   | Enable JIT buyer self-service provisioning on first Auth0 login                             | `true`                                                            | Yes                             |
| `SELF_SIGNUP_TENANT_ID`  |   No   | Target tenant ID for self-signup buyers (defaults to Judge Demo Tenant)                      | `01932b10-0000-7000-8000-000000000a01`                           | Yes                             |
| `PUBLIC_DEMO_TENANT_ID`  |   No   | Default tenant ID for unauthenticated public reads (/v1/services, /v1/availability)         | `01932b10-0000-7000-8000-000000000a01`                           | Yes                             |
| `REDIS_URL`              |   No   | Redis connection URL (not used by runtime; outbox is in PostgreSQL, health returns mock ok) | Not required (defaults to `redis://localhost:6379`)               | No                              |

### Background Worker (`velvetai-worker`)

| Variable       | Secret | Description                                                                      | Value / Source                                               | Needed at 1st Deploy?          |
| :------------- | :----: | :------------------------------------------------------------------------------- | :----------------------------------------------------------- | :----------------------------- |
| `NODE_ENV`     |   No   | Application environment                                                          | `production`                                                 | Yes                            |
| `DATABASE_URL` |  Yes   | Internal connection URI for restricted role `velvet_runtime` (`sslmode=require`) | Set manually after running `scripts/render-db-bootstrap.sql` | No (configured right after DB) |
| `REDIS_URL`    |   No   | Redis connection URL (not used by worker; uses PostgreSQL `outbox_events`)       | Not required (defaults to `redis://localhost:6379`)          | No                             |

### Frontend Static Site (`velvetai-web`)

| Variable                | Secret | Description                                                   | Value / Source                                                | Needed at 1st Deploy?           |
| :---------------------- | :----: | :------------------------------------------------------------ | :------------------------------------------------------------ | :------------------------------ |
| `NODE_VERSION`          |   No   | Build container Node runtime                                  | `24`                                                          | Yes                             |
| `VITE_API_BASE_URL`     |   No   | Public HTTPS base URL of `velvetai-api` (baked at build time) | `https://<api-host>.onrender.com` (initially velvetai-api...) | Yes (rebuild if suffix differs) |
| `VITE_AUTH0_DOMAIN`     |   No   | Auth0 tenant domain                                           | `dev-ru8k002bt7vgmtj5.us.auth0.com`                           | Yes                             |
| `VITE_AUTH0_CLIENT_ID`  |   No   | Auth0 SPA Client ID                                           | `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`                            | Yes                             |
| `VITE_AUTH0_AUDIENCE`   |   No   | Auth0 API Audience                                            | `https://velvetai.example/api`                                | Yes                             |
| `VITE_PAYPAL_CLIENT_ID` |   No   | PayPal Sandbox Client ID for JS SDK v6                        | Copied from PayPal Sandbox Developer App (client id)          | Yes                             |

---

## 4. Step-by-Step Render Deployment Workflow

### Pre-Deployment: Dual Git Push Configuration

Render deploys from fork **`AyuK03/velvetAI`** (private), where the Render GitHub app is installed. Local `origin` is configured with dual push URLs so that every `git push origin <branch>` synchronously pushes to both the upstream `HarK-github/velvetAI` and the deployment fork `AyuK03/velvetAI`:

```zsh
# Verify push URLs
git remote -v
# origin  https://github.com/HarK-github/velvetAI.git (fetch)
# origin  https://github.com/HarK-github/velvetAI.git (push)
# origin  https://github.com/AyuK03/velvetAI.git (push)
```

### Phase 1: Blueprint Provisioning

1. In the Render Dashboard, switch to workspace **`velvetAI Hackathon`**.
2. Click **New +** → **Blueprint**.
3. Connect repository **`AyuK03/velvetAI`**, branch **`main`**.
4. Render automatically parses [`render.yaml`](../render.yaml) and lists:
   - Database: `velvetai-db` (Postgres 17, `basic-256mb` plan)
   - Environment Group: `velvetai-sandbox-secrets`
   - Web Service: `velvetai-api` (Docker, `starter` plan with `preDeployCommand: pnpm --filter @velvetai/db db:migrate`)
   - Worker Service: `velvetai-worker` (Docker, `starter` plan)
   - Static Site: `velvetai-web` (Static, Free plan with SPA rewrite `/*` -> `/index.html`)
5. Fill in the required secrets under `velvetai-sandbox-secrets` (generated via local commands, never committed):
   ```zsh
   # 1. Generate INTENT_SIGNING_KEY (ES256 P-256 PKCS#8 base64 string)
   node -e 'console.log(Buffer.from(require("node:crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"))'

   # 2. Generate CONFIRMATION_TOKEN_SECRET (32 random bytes as 64-character hex string)
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'

   # 3. Generate ENVELOPE_ENCRYPTION_KEY (32 random bytes as 64-character hex string)
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
   ```
   - For `PAYPAL_WEBHOOK_ID`: Enter temporary placeholder `WH-SANDBOX-DEFAULT`. Production env validation accepts it at boot time, allowing the API to deploy cleanly before the webhook endpoint is registered in the PayPal portal.
6. Click **Apply**. Render will provision the database and trigger initial builds.

#### First Deploy Expectations (What Succeeds & What Fails)

On the very first Blueprint apply, the services will display the following behavior:

- **`velvetai-db`**: SUCCEEDS and transitions to status **Available**.
- **`velvetai-api`**:
  - Build phase SUCCEEDS.
  - `preDeployCommand: pnpm --filter @velvetai/db db:migrate` SUCCEEDS using `DATABASE_MIGRATION_URL` (database owner). It runs migrations 0001–0005.
  - Service container startup FAILS with exit code 1 because `DATABASE_URL` is empty (`sync: false`).
- **`velvetai-worker`**: Service container startup FAILS with exit code 1 because `DATABASE_URL` is empty.
- **`velvetai-web`**: Build SUCCEEDS with initial placeholder `VITE_API_BASE_URL`.

**What "Good" Looks Like in Logs on First Apply:**

1. In `velvetai-api` → **Deploy Logs** → **Pre-Deploy**:
   ```text
   Target database: velvetai
   Running migrations...
   0001_initial_schema: OK
   0002_slot_claim_rls_hardening: OK
   0003_payment_core_ledger: OK
   0004_outbox_lease_hardening: OK
   0005_self_membership_rls: OK
   All migrations completed successfully.
   ```
2. In `velvetai-api` → **Logs** (Service startup):
   ```text
   Environment validation failed:
    - DATABASE_URL: Required
   ```

This startup failure is **expected, safe, and deliberate**: per Section J, the API and worker must never run using the superuser/owner database credentials. They remain idle until the restricted `velvet_runtime` user is bootstrapped in Phase 2.

---

### Phase 2: Database Bootstrap & Runtime Role Governance

Once `velvetai-db` reaches status **Available**:

1. In Render Dashboard, click **`velvetai-db`** → **Connect** → **External Connection**.
2. Copy the external PSQL command.
3. In your local terminal, run `scripts/render-db-bootstrap.sql` as the database owner, specifying a strong password for `velvet_runtime`:
   ```zsh
   # Read password securely from hidden terminal prompt
   read -s "RUNTIME_PASS?Enter strong password for velvet_runtime: "
   echo ""
   psql "<EXTERNAL_PSQL_URL>" -v runtime_password="$RUNTIME_PASS" -f scripts/render-db-bootstrap.sql
   unset RUNTIME_PASS
   ```
4. Verify the output:
   - `btree_gist` extension enabled.
   - Role `velvet_runtime` configured with `LOGIN PASSWORD ... NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`.
   - Table count reports all 25 tenant tables under `FORCE ROW LEVEL SECURITY`.

#### Migration Execution Order & Future Migrations (0006–0010)

- **Execution Order**:
  1. `preDeployCommand` runs migrations 0001–0005 as database owner (`DATABASE_MIGRATION_URL`). Migration `0002` safely creates `velvet_runtime NOLOGIN NOBYPASSRLS` if not exists.
  2. `scripts/render-db-bootstrap.sql` executes via external connection, altering `velvet_runtime` to `WITH LOGIN PASSWORD ...` and applying `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO velvet_runtime;` and `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO velvet_runtime;`.
  3. Restricted `DATABASE_URL` is set in Render Dashboard.
  4. Services are redeployed.
- **Future Migrations (0006–0010)**:
  Because `ALTER DEFAULT PRIVILEGES` was executed by the database owner, any new tables, sequences, or functions created by the owner in future migrations automatically inherit full read/write permissions for `velvet_runtime`. No manual grant scripts or role changes are required for future deployments.

---

### Phase 3: Hostname Resolution & Service Configuration

Render URLs are assigned when services are created and may include a 4-character suffix if the base name is already taken globally on Render (e.g., `velvetai-api-a1b2.onrender.com`).

#### Step 1: Read Real Service URLs

1. In Render Dashboard, open **`velvetai-api`** and note the URL at the top left: `https://<real-api-host>`.
2. Open **`velvetai-web`** and note the URL at the top left: `https://<real-web-host>`.

#### Step 2: Configure Runtime Connection Strings

1. Under `velvetai-db` → **Connect** → **Internal Connection**, copy the internal connection URL:
   `postgresql://velvetai_owner:<owner_pass>@dpg-...-a:5432/velvetai`
2. Form the restricted `velvet_runtime` internal URL by replacing the owner username and password with `velvet_runtime` and its password, appending `?sslmode=require`:
   `postgresql://velvet_runtime:<runtime_password>@dpg-...-a:5432/velvetai?sslmode=require`
3. Set environment variable `DATABASE_URL` to this runtime string on:
   - **`velvetai-api`** → Environment → `DATABASE_URL`
   - **`velvetai-worker`** → Environment → `DATABASE_URL`

#### Step 3: Correct Hostname & CORS Variables (If Suffix Assigned)

If the assigned hostnames differ from `velvetai-api.onrender.com` / `velvetai-web.onrender.com`:

1. On **`velvetai-api`** (Environment tab):
   - `ALLOWED_HOSTS`: `<real-api-host>` (host only, e.g. `velvetai-api-a1b2.onrender.com`)
   - `ALLOWED_ORIGINS`: `https://<real-web-host>`
   - `PUBLIC_WEB_ORIGIN`: `https://<real-web-host>`
   - `MCP_RESOURCE_URL`: `https://<real-api-host>/mcp`
2. On **`velvetai-web`** (Environment tab):
   - `VITE_API_BASE_URL`: `https://<real-api-host>`

#### Step 4: Trigger Redeployments

1. **`velvetai-api`**: Click **Manual Deploy** → **Deploy latest commit**.
2. **`velvetai-worker`**: Click **Manual Deploy** → **Deploy latest commit**.
3. **`velvetai-web`**: Click **Manual Deploy** → **Clear build cache & deploy** (CRITICAL: Static sites bake `VITE_*` variables into the JavaScript bundle at build time; clearing cache forces a fresh Vite build).

**What "Good" Looks Like in Logs After Redeploy:**

- `velvetai-api`:
  ```text
  Target database: velvetai
  {"level":"info","time":"...","msg":"Server listening at http://0.0.0.0:3000"}
  ```
- `velvetai-worker`:
  ```text
  Target database: velvetai
  [worker] Outbox processor started with polling interval 1000ms
  ```

---

### Phase 4: Hosted Seed (Canonical Catalog & Test Buyer)

Seed the canonical catalog and provision identities against the hosted database using shell-history-safe hidden prompt `read -s`. Note: Render's external URL enforces SSL; `packages/db/src/client.ts` automatically configures `{ ssl: { rejectUnauthorized: false } }` for non-local hosts.

```zsh
# Read the external database URL securely without leaking into shell history
read -s "DB_URL?Render external DB URL: "
echo ""

# 1. Upsert canonical catalog into synthetic dev tenant
DATABASE_URL="$DB_URL" ALLOW_HOSTED_SEED=1 pnpm dev:catalog:confirm

# 2. Provision test buyer identity (prompts for subject with hidden input: auth0|6af02be79968e1f8f05bcee2)
DATABASE_URL="$DB_URL" ALLOW_HOSTED_SEED=1 pnpm auth:provision-test-user

# 3. Provision agent client identity for M2M MCP Agent
DATABASE_URL="$DB_URL" ALLOW_HOSTED_SEED=1 AUTH0_AGENT_CLIENT_ID="ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut" pnpm auth:provision-agent-client

# Clean up memory variable
unset DB_URL
```

---

### Phase 5: External Dashboard Configurations

#### Auth0 Configuration (Tenant: `dev-ru8k002bt7vgmtj5`)

1. **SPA Application (`velvetAI Web`)**:
   - In Auth0 Dashboard, navigate to **Applications** → **Applications** → **velvetAI Web** (Client ID: `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`).
   - In **Settings** tab, add your Render static site URL to the following fields:
     - **Allowed Callback URLs**: `https://velvetai-five.vercel.app, https://velvetai-five.vercel.app/callback, https://<web-service>.onrender.com, http://localhost:5173, http://localhost:5173/callback`
     - **Allowed Logout URLs**: `https://velvetai-five.vercel.app, https://<web-service>.onrender.com, http://localhost:5173`
     - **Allowed Web Origins**: `https://velvetai-five.vercel.app, https://<web-service>.onrender.com, http://localhost:5173`
   - Click **Save Changes**.

2. **Create Hosted MCP API (`velvetAI MCP (Render)`)**:
   - Navigate to **Applications** → **APIs** → **+ Create API**.
   - Configure:
     - **Name**: `velvetAI MCP (Render)`
     - **Identifier**: `https://<api-service>.onrender.com/mcp`
     - **Signing Algorithm**: `RS256`
   - Click **Create**.
   - Under the **Permissions** tab, add 4 scopes:
     - `booking:read`
     - `booking:quote`
     - `booking:prepare`
     - `booking:commit`

3. **Authorize MCP Agent via Client Access (4/4)**:
   - In Auth0 Dashboard, navigate to **Applications** → **Applications** → **velvetAI MCP Agent** (Client ID: `ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut`).
   - Switch to the **API Access** tab.
   - Locate the row for **`velvetAI MCP (Render)`**.
   - Under the **Client Access** column (not User-delegated), enable access and grant all 4 permissions (`4/4`): `booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`.
   - Click **Save**.

4. **Update Render Environment Variable**:
   - On Render service **`velvetai-api`**, update `MCP_RESOURCE_URL` to `https://<api-service>.onrender.com/mcp`.

#### PayPal Developer Portal (Sandbox)

1. Go to [PayPal Developer Portal](https://developer.paypal.com/dashboard/applications/sandbox).
2. Open your sandbox app → **Webhooks** → **Add Webhook**.
3. **Webhook URL**: `https://<api-service>.onrender.com/v1/webhooks/paypal/default`
   _(Route is `POST /v1/webhooks/paypal/:connectionKey`, matching `provider_connections.connection_key = "default"` seeded for the synthetic development tenant)._
4. **Event Types**: Check the 6 events processed by the authoritative payment reducer:
   - `CHECKOUT.ORDER.APPROVED`
   - `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.PENDING`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
5. Save and copy the Webhook ID (e.g. `WH-...`).
6. In Render Dashboard, paste the ID into `PAYPAL_WEBHOOK_ID` under `velvetai-sandbox-secrets`.
7. Trigger a redeploy of `velvetai-api` and `velvetai-worker`.

---

## 5. Post-Deploy Verification Suite

Run following checks to certify the deployment:

```zsh
# 1. Health checks
curl -fsS https://<api-service>.onrender.com/health/live
curl -fsS https://<api-service>.onrender.com/health/ready

# 2. OAuth Protected Resource Metadata
curl -fsS https://<api-service>.onrender.com/.well-known/oauth-protected-resource
curl -fsS https://<api-service>.onrender.com/.well-known/oauth-protected-resource/mcp

# 3. Cross-Tenant Isolation Verification
DATABASE_URL="<EXTERNAL_RUNTIME_ROLE_URL>" pnpm tsx scripts/hosted-rls-check.ts

# 4. MCP External Client Smoke Test (executes full tool suite and prompts human buyer approval)
API_BASE_URL="https://<api-service>.onrender.com" PUBLIC_WEB_ORIGIN="https://<web-service>.onrender.com" pnpm mcp:smoke
```

---

## 6. Rollback Procedures

### Application Rollback (API & Worker)

If a release causes regressions:

1. In the Render Dashboard, navigate to the affected service (**`velvetai-api`** or **`velvetai-worker`**).
2. Click **Deploys** on the left menu.
3. Locate the previous stable deploy and click **Rollback to this deploy**.
4. Render re-deploys the previous Docker image artifact without rebuilding.

### Database Migration Invariant

Every database migration in `packages/db/src/migrations` must maintain **backward compatibility for at least one prior deploy**:

- New columns must be nullable or provide non-breaking defaults.
- Columns/tables are deprecated and stopped being read before being dropped in a later release.
- Every migration includes a tested `down()` rollback method.
