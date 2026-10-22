# velvetAI Deployment Guide

This document describes the deployment architecture and configuration for velvetAI on [Render](https://render.com) (or any container runtime using Docker).

---

## 1. Architecture Topology

```
                  +---------------------------+
                  |   velvetai-web (Static)   |
                  |     (React 19 / Vite)     |
                  +-------------+-------------+
                                |
                                v (HTTPS REST)
+------------------+     +------+--------------------+     +------------------------+
|  PayPal Sandbox  |<--->|    velvetai-api (Web)     |<--->|      velvetai-db       |
|    REST API v2   |     |    (Fastify 5 Node 24)    |     |    (PostgreSQL 16/17)  |
+------------------+     +---------------------------+     +-----------+------------+
        ^                                                              ^
        |                                                              |
        |                +---------------------------+                 |
        +--------------->|   velvetai-worker (Bg)    |<----------------+
                         |  (Outbox & Reconciliation)|
                         +---------------------------+
```

1. **`velvetai-api`**: Fastify 5 REST API handling catalog, availability, booking quotes, slot holds with GiST exclusion, signed intents, PayPal order creation, and capture processing.
2. **`velvetai-worker`**: Background worker running `HoldReaperProcessor`, `PostgreSqlOutboxStore` (claiming transactional outbox events using `FOR UPDATE SKIP LOCKED` with fenced leases), and `ReconciliationProcessor` (periodically polling `provider_operations` requiring reconciliation).
3. **`velvetai-web`**: React 19 SPA built with Vite, embedding PayPal JS SDK v6 for buyer approval.
4. **`velvetai-db`**: Managed PostgreSQL database with 25 tables enforcing `FORCE ROW LEVEL SECURITY`.

---

## 2. Environment Variables

### API Service (`velvetai-api`)

| Variable                    | Required | Default      | Description                                                                            |
| --------------------------- | -------- | ------------ | -------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | Yes      | `production` | Runtime mode (`production`, `development`, `test`).                                    |
| `PORT`                      | Yes      | `3000`       | Port for Fastify HTTP server.                                                          |
| `DATABASE_URL`              | Yes      | -            | PostgreSQL connection URI (`postgresql://user:pass@host:5432/dbname?sslmode=require`). |
| `DATABASE_POOL_MIN`         | No       | `2`          | Minimum connection pool size.                                                          |
| `DATABASE_POOL_MAX`         | No       | `10`         | Maximum connection pool size.                                                          |
| `PAYPAL_ENVIRONMENT`        | Yes      | `sandbox`    | **Strictly `sandbox`**. Live payments are rejected by configuration schema and client. |
| `PAYPAL_CLIENT_ID`          | Yes      | -            | PayPal REST App Sandbox Client ID.                                                     |
| `PAYPAL_CLIENT_SECRET`      | Yes      | -            | PayPal REST App Sandbox Client Secret.                                                 |
| `PAYPAL_WEBHOOK_ID`         | Yes      | -            | Webhook ID registered on PayPal Developer Portal for your API URL.                     |
| `INTENT_SIGNING_KEY`        | Yes      | -            | Secret or ES256 private key for signing booking intents (>= 16 chars).                 |
| `CONFIRMATION_TOKEN_SECRET` | Yes      | -            | Secret for buyer confirmation token hashing (>= 16 chars).                             |
| `ENVELOPE_ENCRYPTION_KEY`   | Yes      | -            | 32-byte hex key for envelope encryption.                                               |
| `WEB_BASE_URL`              | Yes      | -            | Public URL of `velvetai-web` for CORS origin header validation.                        |

### Background Worker (`velvetai-worker`)

| Variable               | Required | Default      | Description                                                                               |
| ---------------------- | -------- | ------------ | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`             | Yes      | `production` | Must be `production` in live environments (`InMemoryOutboxStore` will throw fatal error). |
| `DATABASE_URL`         | Yes      | -            | PostgreSQL connection URI.                                                                |
| `DATABASE_POOL_MIN`    | No       | `1`          | Minimum connection pool size.                                                             |
| `DATABASE_POOL_MAX`    | No       | `5`          | Maximum connection pool size.                                                             |
| `PAYPAL_ENVIRONMENT`   | Yes      | `sandbox`    | Strictly `sandbox`.                                                                       |
| `PAYPAL_CLIENT_ID`     | Yes      | -            | PayPal Sandbox Client ID (for reconciliation queries).                                    |
| `PAYPAL_CLIENT_SECRET` | Yes      | -            | PayPal Sandbox Client Secret.                                                             |

### Frontend Static Site (`velvetai-web`)

| Variable                  | Required | Default   | Description                                           |
| ------------------------- | -------- | --------- | ----------------------------------------------------- |
| `VITE_API_BASE_URL`       | Yes      | -         | Public HTTPS URL of `velvetai-api`.                   |
| `VITE_PAYPAL_CLIENT_ID`   | Yes      | -         | PayPal Sandbox Client ID for JS SDK v6 script loader. |
| `VITE_PAYPAL_ENVIRONMENT` | Yes      | `sandbox` | Strictly `sandbox`.                                   |

---

## 3. Render Deployment (`render.yaml`)

Deploying to Render is automated via the root [`render.yaml`](../render.yaml) Blueprint:

1. In Render Dashboard, click **New +** -> **Blueprint**.
2. Connect your GitHub repository.
3. Render automatically discovers `render.yaml` and provisions:
   - Managed PostgreSQL instance (`velvetai-db`)
   - Pre-deploy database migration command (`pnpm --filter @velvetai/db db:migrate`)
   - Web Service (`velvetai-api`) with healthcheck at `/healthz`
   - Background Worker (`velvetai-worker`)
   - Static Web Site (`velvetai-web`)
4. Fill in PayPal Sandbox credentials in the Render dashboard:
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_CLIENT_SECRET`
   - `PAYPAL_WEBHOOK_ID` (after creating webhook in step 5)
5. In PayPal Developer Portal, create a Webhook targeting:
   `https://<your-api-url>.onrender.com/v1/webhooks/paypal/primary`
   and subscribe to:
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `CHECKOUT.ORDER.APPROVED`

---

## 4. Docker Container Deployment

If deploying via container orchestrators (Docker Compose, ECS, Kubernetes):

```bash
# Build API container
docker build -f Dockerfile.api -t velvetai-api:latest .

# Build Worker container
docker build -f Dockerfile.worker -t velvetai-worker:latest .

# Build Web container
docker build -f Dockerfile.web -t velvetai-web:latest .
```

### Healthcheck Endpoints

- Liveness: `GET /health/live` or `GET /healthz` (Returns HTTP 200 `{ status: "ok" }`)
- Readiness: `GET /health/ready` (Returns HTTP 200 `{ status: "ready", dependencies: { database: "ok" } }`)

### Pre-Deploy Database Migrations

Always run migrations before starting new API/Worker versions:

```bash
pnpm db:migrate
```
