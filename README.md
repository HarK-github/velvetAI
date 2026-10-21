# velvetAI

> **AI books it. PayPal seals it.**
>
> Production-grade appointment booking and deposit platform for local service businesses, designed for autonomous AI agents with PayPal payment security and deterministic safety enforcement through the Agent Abuse Lab.

---

## Architecture Overview

velvetAI is built as a TypeScript modular monolith in a pnpm/Turborepo workspace:

### Applications (`apps/`)

- **`apps/api`**: Fastify 5 REST API, RFC 9457 Problem Details, OpenAPI generation, mutation idempotency, tenant context.
- **`apps/web`**: React 19, Vite, TanStack Router/Query, booking and schedule interfaces.
- **`apps/worker`**: Background worker for transactional outbox dispatching, safe concurrent claiming (`FOR UPDATE SKIP LOCKED`), and inbox deduplication.
- **`apps/abuse-lab`**: Automated security validation suite executing 20+ deterministic attack scenarios.

### Packages (`packages/`)

- **`packages/contracts`**: Shared Zod schemas, branded primitive types (UUIDv7, MoneyMinor, IanaTimeZone, CurrencyCode), Problem Details schemas.
- **`packages/domain`**: Pure domain entities, value objects, invariants, and domain error classes (zero external framework dependencies).
- **`packages/application`**: Hexagonal ports (Authentication, Payment, Clock) and command/query handlers.
- **`packages/db`**: PostgreSQL 17 migrations, Kysely SQL query client, tenant isolation utilities.
- **`packages/tool-registry`**: Shared tool definitions and execution registry for REST, MCP, WebMCP, and Ask AI.
- **`packages/integrations-paypal`**: Typed PayPal REST adapters (Orders v2, Payments v2, Invoicing v2, Webhooks v1).
- **`packages/forecasting`**: Baseline statistical models (no-show, slot-fill, cash forecast) with Brier and WAPE metrics.
- **`packages/observability`**: Structured Pino logging with mandatory secret/PII redaction and Zod environment validation.

---

## Prerequisites

- **Node.js**: `v20.x`, `v22.x`, or `v24.x LTS`
- **pnpm**: `v10.x` or `v12.x` (managed via corepack)
- **Docker & Docker Compose**: For local PostgreSQL 17 (`btree_gist` extension) and Redis 7

---

## Local Setup (PowerShell & CI Compatible)

### 1. Clone & Enter Directory

```powershell
git clone <repo-url> velvetAI
cd velvetAI
```

### 2. Configure Environment

Copy the `.env.example` file to `.env`:

```powershell
Copy-Item .env.example .env
```

_(On Linux/macOS: `cp .env.example .env`)_

### 3. Start Local PostgreSQL and Redis

```powershell
pnpm docker:up
```

### 4. Install Dependencies

```powershell
pnpm install
```

### 5. Run Verification Checks

```powershell
# Typecheck all packages and apps (strict TypeScript)
pnpm typecheck

# Lint all code (ESLint 9 flat config, zero warnings)
pnpm lint

# Run all unit, property, and integration tests across monorepo
pnpm test

# Run PostgreSQL 17 concurrency, RLS isolation, and hold reaper tests directly
pnpm --filter @velvetai/db test
pnpm --filter @velvetai/application test
pnpm --filter @velvetai/worker test
pnpm --filter @velvetai/abuse-lab test

# Build all packages and applications
pnpm build
```

### 6. Start Development Servers

```powershell
pnpm dev
```

---

## Security Invariants

1. **Multi-Tenancy & RLS**: Tenant identity is always derived from authenticated membership tokens; `tenant_id` is never accepted from client bodies or query parameters. All 16 tenant tables enforce `FORCE ROW LEVEL SECURITY`. Queries execute strictly within `withTenantTransaction` using `SET LOCAL app.tenant_id`, guaranteeing zero connection pool context leakage.
2. **Concurrency Safety**: Resource slot holds are protected against double bookings using PostgreSQL GiST exclusion constraints on `(tenant_id, resource_id, blocked_during) WHERE (blocking)`. Overlap checks evaluate persisted blocking state, never wall-clock functions.
3. **Dual Trust Claims**: Booking intent integrity is cryptographically sealed via ES256 IEEE-P1363 JWS with strict header validation (`typ: velvetai-intent+jwt`, `alg: ES256`, explicit `kid`). Buyer approval is captured separately through a single-use opaque confirmation token via an interactive approval locator. Commit requires both artifacts.
4. **Financial Integrity**: Money is stored strictly as integer minor units (`bigint`); floating-point money is prohibited.
5. **Idempotency**: All mutating operations support `Idempotency-Key` with canonical payload hashing and 409 conflict detection on hash mismatch.
6. **Durable Events**: Domain mutations and outbox events commit together in one atomic database transaction. Zero network calls occur inside commit transactions.
7. **Redaction**: Access tokens, PayPal secrets, customer notes, and direct PII are censored from application logs.
