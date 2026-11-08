# Render Deployment Evidence (Package 03)

- **Date**: Sun Nov 8, 2026
- **Commit SHA**: `feat/epic5-track-a`
- **Render Workspace**: `velvetAI Hackathon`
- **Blueprint Repository**: `AyuK03/velvetAI` (branch `main`)

## 1. Deployed Service Endpoints

| Service             | Type                       | URL                                  |
| :------------------ | :------------------------- | :----------------------------------- |
| **velvetai-web**    | Static Site                | `https://<web-service>.onrender.com` |
| **velvetai-api**    | Web Service (Docker)       | `https://<api-service>.onrender.com` |
| **velvetai-worker** | Background Worker (Docker) | Private Service                      |
| **velvetai-db**     | Managed PostgreSQL 17      | `dpg-...-a:5432/velvetai`            |

## 2. Health & Protocol Verification

### Liveness Endpoint

```zsh
curl -fsS https://<api-service>.onrender.com/health/live
```

```json
{ "status": "ok", "timestamp": "2026-11-08T...Z" }
```

### Readiness Endpoint

```zsh
curl -fsS https://<api-service>.onrender.com/health/ready
```

```json
{
  "status": "ready",
  "timestamp": "2026-11-08T...Z",
  "dependencies": { "database": "ok", "redis": "ok" }
}
```

### OAuth Protected Resource Metadata

```zsh
curl -fsS https://<api-service>.onrender.com/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://velvetai.example/api",
  "authorization_servers": ["https://dev-ru8k002bt7vgmtj5.us.auth0.com/"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": [
    "booking:read",
    "booking:quote",
    "booking:prepare",
    "booking:commit",
    "booking:cancel",
    "merchant:schedule",
    "merchant:refund"
  ]
}
```

```zsh
curl -fsS https://<api-service>.onrender.com/.well-known/oauth-protected-resource/mcp
```

```json
{
  "resource": "https://<api-service>.onrender.com/mcp",
  "authorization_servers": ["https://dev-ru8k002bt7vgmtj5.us.auth0.com/"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["booking:read", "booking:quote", "booking:prepare", "booking:commit"]
}
```

## 3. Database Bootstrap & Role Introspection

```sql
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN (current_user, 'velvet_runtime');
```

```text
    rolname     | rolsuper | rolbypassrls | rolcanlogin
----------------+----------+--------------+-------------
 velvetai_owner | f        | f            | t
 velvet_runtime | f        | f            | t
```

## 4. Cross-Tenant Isolation Verification

```zsh
DATABASE_URL="<EXTERNAL_RUNTIME_ROLE_URL>" pnpm tsx scripts/hosted-rls-check.ts
```

```text
Target database: velvetai
Starting Hosted Database RLS & Tenant Isolation Verification...

1. Connected Role Security Attributes:
   - Role Name:    velvet_runtime
   - Is Superuser: false (must be false)
   - Has BypassRLS: false (must be false)
2. FORCE ROW LEVEL SECURITY Tables: 25 tables protected.

3. Unscoped Direct Query (No app.tenant_id set):
   - Locations visible: 0 (expected: 0)
   - Services visible:  0 (expected: 0)
4. Tenant A Context (01932b10-0000-7000-8000-000000000001):
   - Locations visible: 1
   - Services visible:  3
5. Cross-Tenant Isolation (Tenant B Context 01932b10-0000-7000-8000-000000000099):
   - Tenant A rows visible to Tenant B: 0 (expected: 0)

RLS & Cross-Tenant Isolation Verification: PASSED
```

## 5. Background Worker Operational Logs

```text
[worker] Outbox processor started. Polling interval: 5000ms
[worker] Hold reaper processor started. Sweep interval: 30000ms
[worker] Reconciliation loop active. Interval: 60000ms
```
