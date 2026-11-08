# velvetAI Production Deployment Guide (Render)

This document provides the authoritative, tested deployment architecture, configuration, and runbook for velvetAI on [Render](https://render.com).

---

## 1. Architecture Topology

```
                  +---------------------------+
                  |   velvetai-web (Static)   |
                  |     (React 19 / Vite)     |
                  +-------------+-------------+
                                |
                                v (HTTPS REST & SSE)
+------------------+     +------+--------------------+     +------------------------+
|  PayPal Sandbox  |<--->|    velvetai-api (Web)     |<--->|      velvetai-db       |
|    REST API v2   |     |  (Fastify 5 / Docker)     |     | (Managed PostgreSQL 17)|
+------------------+     +---------------------------+     +-----------+------------+
        ^                               ^                              ^
        |                               |                              |
        |                +--------------+------------+                 |
        +--------------->|   velvetai-worker (Bg)    |<----------------+
                         |  (Outbox & Reconciliation)|
                         +---------------------------+
```

1. **`velvetai-api`** (Web Service, Docker runtime): Fastify 5 REST API, MCP 2026-07-28 endpoint (`/mcp`), Ask AI (`/v1/ai/chat` with Google Gemini & rate limiting), and PayPal webhooks. Health check path: `/health/ready`.
2. **`velvetai-worker`** (Background Worker, Docker runtime): Transactional outbox relay (`FOR UPDATE SKIP LOCKED`), hold reaper, and PayPal reconciliation processor.
3. **`velvetai-web`** (Static Site, Node 24 build): React 19 SPA built with Vite, Auth0 SPA SDK, and PayPal JS SDK v6.
4. **`velvetai-db`** (Managed PostgreSQL 17): PostgreSQL 17 database enforcing `FORCE ROW LEVEL SECURITY`, `btree_gist` exclusion constraints, and isolated non-superuser runtime role (`velvet_runtime`).

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

| Variable                       | Secret | Description                                                | Example / Placeholder      |
| :----------------------------- | :----: | :--------------------------------------------------------- | :------------------------- |
| `PAYPAL_ENVIRONMENT`           |   No   | PayPal execution mode (must be `sandbox`)                  | `sandbox`                  |
| `PAYPAL_CLIENT_ID`             |  Yes   | PayPal REST Sandbox App Client ID                          | `AU_...`                   |
| `PAYPAL_CLIENT_SECRET`         |  Yes   | PayPal REST Sandbox App Client Secret                      | `EL_...`                   |
| `PAYPAL_WEBHOOK_ID`            |  Yes   | Webhook ID returned when creating webhook in PayPal portal | `WH-...`                   |
| `GOOGLE_GENERATIVE_AI_API_KEY` |  Yes   | Google AI Studio API Key for Gemini                        | `AIzaSy...`                |
| `INTENT_SIGNING_KEY`           |  Yes   | 32-byte hex key for signing booking intents                | `a1b2c3...` (64 hex chars) |
| `CONFIRMATION_TOKEN_SECRET`    |  Yes   | 32-byte hex secret for confirmation token hashing          | `d4e5f6...` (64 hex chars) |
| `ENVELOPE_ENCRYPTION_KEY`      |  Yes   | 32-byte hex key for field encryption                       | `7890ab...` (64 hex chars) |

### API Service (`velvetai-api`)

| Variable                 | Secret | Description                                                  | Example / Placeholder                                        |
| :----------------------- | :----: | :----------------------------------------------------------- | :----------------------------------------------------------- |
| `NODE_ENV`               |   No   | Application environment                                      | `production`                                                 |
| `DATABASE_URL`           |  Yes   | Internal connection URI for restricted role `velvet_runtime` | `postgresql://velvet_runtime:<pass>@dpg-...-a:5432/velvetai` |
| `DATABASE_MIGRATION_URL` |  Yes   | Owner connection URI wired via `fromDatabase: velvetai-db`   | Automatically populated by Render Blueprint                  |
| `AUTH0_ISSUER`           |   No   | Auth0 OIDC Issuer URL with trailing slash                    | `https://dev-ru8k002bt7vgmtj5.us.auth0.com/`                 |
| `AUTH0_AUDIENCE`         |   No   | Auth0 API identifier for velvetAI API                        | `https://velvetai.example/api`                               |
| `MCP_RESOURCE_URL`       |   No   | Render MCP API identifier registered in Auth0                | `https://<api-service>.onrender.com/mcp`                     |
| `PUBLIC_WEB_ORIGIN`      |   No   | Canonical origin of the frontend static site                 | `https://<web-service>.onrender.com`                         |
| `ALLOWED_ORIGINS`        |   No   | CORS allowed origins                                         | `https://<web-service>.onrender.com`                         |
| `ALLOWED_HOSTS`          |   No   | Fastify trusted hostnames                                    | `<api-service>.onrender.com`                                 |
| `AI_PROVIDER`            |   No   | Active AI model provider                                     | `gemini`                                                     |
| `AI_MODEL`               |   No   | Primary Gemini model ID                                      | `gemini-3.5-flash-lite`                                      |
| `AI_DAILY_TURN_BUDGET`   |   No   | Global daily turn budget cap for public demo                 | `1500`                                                       |

### Background Worker (`velvetai-worker`)

| Variable       | Secret | Description                                                  | Example / Placeholder                                        |
| :------------- | :----: | :----------------------------------------------------------- | :----------------------------------------------------------- |
| `NODE_ENV`     |   No   | Application environment                                      | `production`                                                 |
| `DATABASE_URL` |  Yes   | Internal connection URI for restricted role `velvet_runtime` | `postgresql://velvet_runtime:<pass>@dpg-...-a:5432/velvetai` |

### Frontend Static Site (`velvetai-web`)

| Variable                | Secret | Description                             | Example / Placeholder                |
| :---------------------- | :----: | :-------------------------------------- | :----------------------------------- |
| `NODE_VERSION`          |   No   | Build container Node runtime            | `24`                                 |
| `VITE_API_BASE_URL`     |   No   | Public HTTPS base URL of `velvetai-api` | `https://<api-service>.onrender.com` |
| `VITE_AUTH0_DOMAIN`     |   No   | Auth0 tenant domain                     | `dev-ru8k002bt7vgmtj5.us.auth0.com`  |
| `VITE_AUTH0_CLIENT_ID`  |   No   | Auth0 SPA Client ID                     | `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`   |
| `VITE_AUTH0_AUDIENCE`   |   No   | Auth0 API Audience                      | `https://velvetai.example/api`       |
| `VITE_PAYPAL_CLIENT_ID` |   No   | PayPal Sandbox Client ID for JS SDK v6  | `AU_...`                             |

---

## 4. Step-by-Step Render Deployment Workflow

### Phase 1: Blueprint Provisioning

1. In the Render Dashboard, switch to workspace **`velvetAI Hackathon`**.
2. Click **New +** → **Blueprint**.
3. Connect repository **`AyuK03/velvetAI`**, branch **`main`**.
4. Render automatically parses [`render.yaml`](../render.yaml) and lists:
   - Database: `velvetai-db` (Postgres 17, Starter plan)
   - Environment Group: `velvetai-sandbox-secrets`
   - Web Service: `velvetai-api` (Docker, Starter plan)
   - Worker Service: `velvetai-worker` (Docker, Starter plan)
   - Static Site: `velvetai-web` (Static, Free plan)
5. Fill in the required secrets under `velvetai-sandbox-secrets` (generated via local commands, never committed):
   ```zsh
   # Generate INTENT_SIGNING_KEY
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'

   # Generate CONFIRMATION_TOKEN_SECRET
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'

   # Generate ENVELOPE_ENCRYPTION_KEY
   node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
   ```
6. Click **Apply**. Render will provision the database and trigger the initial builds.

---

### Phase 2: Database Bootstrap (Restricted Runtime Role)

Once `velvetai-db` reaches status **Available**:

1. In Render Dashboard, click **`velvetai-db`** → **Connect** → **External Connection**.
2. Copy the external PSQL command.
3. In your local terminal, run `scripts/render-db-bootstrap.sql` as the database owner, specifying a strong password for `velvet_runtime`:
   ```zsh
   psql "<EXTERNAL_PSQL_URL>" -v runtime_password="<GENERATE_STRONG_RUNTIME_PASSWORD>" -f scripts/render-db-bootstrap.sql
   ```
4. Verify the output:
   - `btree_gist` extension enabled.
   - Role `velvet_runtime` created/updated with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN`.
   - Table count reports all tenant tables under `FORCE ROW LEVEL SECURITY`.

---

### Phase 3: Configure Runtime Connection Strings

1. Under `velvetai-db` → **Connect** → **Internal Connection**, copy the internal connection URL:
   `postgresql://velvetai_owner:<owner_pass>@dpg-...-a:5432/velvetai`
2. Form the restricted `velvet_runtime` internal URL by replacing the username and password:
   `postgresql://velvet_runtime:<runtime_password>@dpg-...-a:5432/velvetai`
3. In Render Dashboard, set environment variable `DATABASE_URL` to this runtime string on:
   - **`velvetai-api`** → Environment → `DATABASE_URL`
   - **`velvetai-worker`** → Environment → `DATABASE_URL`
4. Trigger manual deploy of `velvetai-api` and `velvetai-worker`.

---

### Phase 4: Hosted Seed (Canonical Catalog & Test Buyer)

Run the one-time migration and seed from your local Mac using `ALLOW_HOSTED_SEED=1` and the database's External Connection URL:

```zsh
# 1. Run migrations against hosted DB as owner
DATABASE_URL="<EXTERNAL_DB_URL>" pnpm --filter @velvetai/db db:migrate

# 2. Seed canonical catalog into synthetic dev tenant
ALLOW_HOSTED_SEED=1 DATABASE_URL="<EXTERNAL_DB_URL>" pnpm dev:catalog:confirm

# 3. Provision test buyer identity
ALLOW_HOSTED_SEED=1 DATABASE_URL="<EXTERNAL_DB_URL>" pnpm auth:provision-test-user auth0|6af02be79968e1f8f05bcee2

# 4. Provision agent client identity
ALLOW_HOSTED_SEED=1 DATABASE_URL="<EXTERNAL_DB_URL>" AUTH0_AGENT_CLIENT_ID="ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut" pnpm auth:provision-agent-client
```

---

### Phase 5: External Dashboard Configurations

#### Auth0 Configuration (Tenant: `dev-ru8k002bt7vgmtj5`)

1. **velvetAI Web Application**:
   - Go to **Applications** → **velvetAI Web** (Client ID: `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`).
   - Add `https://<web-service>.onrender.com` to **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**.
   - Click **Save Changes**.
2. **velvetAI MCP API for Render**:
   - Go to **Applications** → **APIs** → **Create API**.
   - Name: `velvetAI MCP (Render)`.
   - Identifier: `https://<api-service>.onrender.com/mcp`.
   - Signing Algorithm: `RS256`.
   - Under **Permissions**, add: `booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`.
   - Under **Machine to Machine Applications**, authorize `velvetAI MCP Agent` (`ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut`) with all 4 permissions (`4/4`).
   - Set Render env `MCP_RESOURCE_URL=https://<api-service>.onrender.com/mcp` on `velvetai-api`.

#### PayPal Developer Portal (Sandbox)

1. Go to [PayPal Developer Portal](https://developer.paypal.com/dashboard/applications/sandbox).
2. Open your sandbox app → **Webhooks** → **Add Webhook**.
3. URL: `https://<api-service>.onrender.com/v1/webhooks/paypal/primary`
4. Subscribe to events:
   - `CHECKOUT.ORDER.APPROVED`
   - `CHECKOUT.PAYMENT-APPROVAL.REVERSED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.PENDING`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
5. Save and copy the Webhook ID into Render env `PAYPAL_WEBHOOK_ID`.

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

# 4. MCP External Client Smoke Test
MCP_URL=https://<api-service>.onrender.com/mcp pnpm mcp:smoke
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
