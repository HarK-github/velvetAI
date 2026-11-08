# Auth0 Setup Guide for VelvetAI

This guide provides step-by-step instructions for configuring Auth0 for VelvetAI, supporting both the React/Vite single-page application (SPA) and backend OAuth/OIDC token verification.

> [!IMPORTANT]
> Never place real client secrets, management tokens, or tenant credentials in committed repository files. All local values should remain in untracked `.env` files.

---

## 1. Auth0 Tenant & Architecture Overview

- **Active Tenant**: `dev-ru8k002bt7vgmtj5.us.auth0.com` (migrated 2026-11-08 from deprecated tenant `dev-o55m2ek822mgtiim`).
- **Core Objects**:
  - **API `velvetAI API`**: Identifier `https://velvetai.example/api`, RS256 signing, 7 fine-grained permissions.
  - **SPA Application `velvetAI Web`**: Client ID `UDUndVMtt7rVZS874ztyNbcrRBSKNhMc`, User-delegated access 7/7 to `velvetAI API`.
  - **Local MCP API `velvetAI MCP`**: Identifier `http://localhost:3000/mcp`, 4 permissions.
  - **Hosted MCP API `velvetAI MCP (Render)`**: Identifier `https://<api-service>.onrender.com/mcp`, 4 permissions.
  - **M2M Application `velvetAI MCP Agent`**: Client ID `ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut`, Client Access 4/4 to MCP APIs.
  - **Provisioned Test Buyer**: Auth0 subject `auth0|6af02be79968e1f8f05bcee2` (mapped to PostgreSQL synthetic dev tenant as `BUYER`).
  - **Provisioned Agent Client**: Subject `ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut@clients` (mapped to PostgreSQL synthetic dev tenant as `BUYER`).

---

## 2. Configure velvetAI API & Audience

1. In the Auth0 sidebar, navigate to **Applications** > **APIs**.
2. Click **+ Create API**.
3. Configure the following parameters:
   - **Name**: `VelvetAI API`
   - **Identifier (Audience)**: `https://velvetai.example/api` (or your domain API identifier)
   - **Signing Algorithm**: `RS256` (VelvetAI strictly enforces RS256 with asymmetric JWKS verification).
4. Click **Create**.
5. Under the **Permissions (Scopes)** tab for the created API, add the fine-grained scopes defined in VelvetAI:
   - `booking:read` — Read services, locations, availability, and bookings.
   - `booking:quote` — Request and compute 5-minute versioned quotes.
   - `booking:prepare` — Create slot holds and signed intent snapshots.
   - `booking:commit` — Commit bookings with verified human confirmation tokens.
   - `booking:cancel` — Prepare and commit booking cancellations.
   - `merchant:schedule` — Manage availability rules and check-in attendance.
   - `merchant:refund` — Authorize merchant-directed refund adjustments.

---

## 3. Configure velvetAI Web SPA Application

1. In the sidebar, navigate to **Applications** > **Applications**.
2. Click **+ Create Application**.
3. Set the name to `VelvetAI Web SPA` and choose **Single Page Web Applications**.
4. Click **Create**, then select the **Settings** tab.
5. Scroll down to **Application URIs** and configure:
   - **Allowed Callback URLs**:
     ```text
     http://localhost:5173, http://localhost:5173/callback, https://velvetai.onrender.com, https://velvetai.onrender.com/callback
     ```
   - **Allowed Logout URLs**:
     ```text
     http://localhost:5173, https://velvetai.onrender.com
     ```
   - **Allowed Web Origins**:
     ```text
     http://localhost:5173, https://velvetai.onrender.com
     ```
   - **Allowed Origins (CORS)**:
     ```text
     http://localhost:5173, https://velvetai.onrender.com
     ```
6. Click **Save Changes**.

---

## 4. Machine-to-Machine MCP Applications & Hosted Render Configuration

### A. Pre-configured Local M2M Agent (`velvetAI MCP Agent`)

- **Application**: `velvetAI MCP Agent` (Client ID: `ULbcuvsdRzS9hsNWRe9pgx7BQRhae8Ut`).
- **Auth Method**: Client Secret (Post).
- **Authorizations**:
  - Local API `velvetAI MCP` (`http://localhost:3000/mcp`): Client Access 4/4 (`booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`).

### B. Hosted Render MCP API & Agent Authorization

When deploying to Render:

1. Navigate to **Applications** → **APIs** → **+ Create API**.
2. Configure:
   - **Name**: `velvetAI MCP (Render)`
   - **Identifier**: `https://<api-service>.onrender.com/mcp`
   - **Signing Algorithm**: `RS256`
3. Under the **Permissions** tab, add 4 scopes:
   - `booking:read`
   - `booking:quote`
   - `booking:prepare`
   - `booking:commit`
4. Under **Applications** → **Applications** → **`velvetAI MCP Agent`**, navigate to the **API Access** tab.
5. In the table, locate **`velvetAI MCP (Render)`**.
6. Under the **Client Access** column (not User-delegated), enable access and grant all 4 permissions (`4/4`): `booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`.
7. Click **Save**.
8. Set the Render API service environment variable `MCP_RESOURCE_URL` to `https://<api-service>.onrender.com/mcp`.

---

## 5. Local Environment Configuration

Copy `.env.example` to `.env` and fill in your Auth0 details:

```bash
# Server-side Auth0 configuration (apps/api)
AUTH0_ISSUER=<AUTH0_ISSUER>
AUTH0_AUDIENCE=https://velvetai.example/api
AUTH0_JWKS_URI=<AUTH0_ISSUER>.well-known/jwks.json

# Client-side configuration (apps/web)
VITE_AUTH0_DOMAIN=<AUTH0_DOMAIN>
VITE_AUTH0_CLIENT_ID=<your-spa-client-id>
VITE_AUTH0_AUDIENCE=https://velvetai.example/api
```

---

## 6. Architecture & Local RBAC Authority Invariant

VelvetAI uses Auth0 strictly as an **Identity Provider**:

- External Auth0 tokens prove the user's authenticated subject (`sub`).
- **PostgreSQL `memberships` table remains the single authoritative source of truth** for tenant isolation, local user ID, roles, role versions, and instant revocation.
- If a user's membership in PostgreSQL has `revoked_at IS NOT NULL` or the `role_version` is outdated, the API immediately rejects the request with HTTP 403 Forbidden even if the Auth0 JWT is cryptographically valid.

---

## 7. Provisioning Test Users for Local Development

When an Auth0 user logs into the local velvetAI web application (`http://localhost:5173`), the API strictly verifies the token against Auth0 JWKS and then looks up the local `app_users` and `memberships` records in PostgreSQL. If the user's Auth0 subject (`sub`) is not yet mapped in PostgreSQL, the API returns HTTP 403 (`user_not_found`).

To map your Auth0 test user into the local database, run the development provisioning CLI:

```bash
pnpm auth:provision-test-user
```

### Interactive Steps:

1. Locate your test user's `sub` identifier in the Auth0 Dashboard (**User Management** > **Users** > click your test user > copy the `user_id`, e.g., `auth0|6716...` or `google-oauth2|...`).
2. Run `pnpm auth:provision-test-user` in your terminal.
3. When prompted:
   ```text
   Enter Auth0 subject ('sub') [input hidden]:
   ```
   Paste or type your user's `sub` identifier. Keystrokes are completely hidden and are never logged or echoed to the console.
4. The CLI executes a single database transaction to:
   - Insert or match the user in `app_users` with `oidc_subject`.
   - Attach the user to the synthetic development/judge tenant (`01932b10-0000-7000-8000-000000000001`).
   - Assign strictly the `BUYER` role (`role_version = 1`, `revoked_at = NULL`).
   - Output redacted identifiers only.
5. Re-running the command with the same subject is completely idempotent and will never create duplicate user or membership records.
6. The CLI strictly refuses to run when `NODE_ENV=production`.
7. Once provisioned, return to `http://localhost:5173` in your browser and refresh the page. The status badge will change from `HTTP 403` to `HTTP 200`.
