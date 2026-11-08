# velvetAI Test Architecture & Database Isolation

## Overview

velvetAI uses a multi-package monorepo architecture managed by Turborepo and pnpm workspaces. When running automated test suites, multiple packages containing database-backed integration tests (`@velvetai/db`, `@velvetai/application`, `@velvetai/api`, `@velvetai/worker`, and `@velvetai/abuse-lab`) can execute concurrently.

To prevent test fixture collision, race conditions, and migration rollback interference under parallel test execution, velvetAI implements **Approach A: Per-Package Test Database Isolation**.

---

## 1. Test Database Isolation Architecture (Approach A)

### Isolated Database Mapping

Each workspace package is allocated an independent, fully isolated PostgreSQL test database:

| Package Scope                            | Target Test Database        | Purpose                                                         |
| :--------------------------------------- | :-------------------------- | :-------------------------------------------------------------- |
| **Base / Fallback**                      | `velvetai_test`             | Default test database                                           |
| **`@velvetai/db`**                       | `velvetai_test_db`          | RLS isolation, client pooling, and exclusion constraint tests   |
| **`@velvetai/db` (Migration Lifecycle)** | `velvetai_test_migration`   | Dedicated isolation for down/up migration lifecycle tests       |
| **`@velvetai/application`**              | `velvetai_test_application` | Concurrency booking, cancellation, attendance, and ledger tests |
| **`@velvetai/api`**                      | `velvetai_test_api`         | Fastify route tests, idempotency, Auth0 auth, and MCP routes    |
| **`@velvetai/worker`**                   | `velvetai_test_worker`      | Hold reaper and PostgreSQL outbox reconciliation tests          |
| **`@velvetai/abuse-lab`**                | `velvetai_test_abuse_lab`   | Deterministic abuse scenarios and security attack suites        |

### Parallel Worktree Support (`TEST_DB_SUFFIX`)

When running parallel tracks (e.g., Track A in `velvetAI` and Track B in `velvetAI-b`), test databases are further isolated by an optional suffix set via `TEST_DB_SUFFIX` in `.env.local` (e.g. `TEST_DB_SUFFIX=_b`).
This derives isolated database names such as `velvetai_test_b`, `velvetai_test_api_b`, etc., allowing simultaneous test executions without cross-talk.

### Authoritative Environment Loading & `TEST_DB_SUFFIX` Invariant

Environment loading across scripts, workers, APIs, and Vitest runs is managed centrally by `@velvetai/observability` (`loadRootEnv`).

Precedence order:

1. `process.env` (system/shell environment variables take highest precedence).
2. `.env.local` (worktree-local overrides: ports, local database names, `TEST_DB_SUFFIX`).
3. `.env.test` (applied when `NODE_ENV=test` for test defaults like `OIDC_MOCK_ENABLED=true`).
4. `.env` (base repo defaults).

> [!IMPORTANT]
> **Decision on `TEST_DB_SUFFIX`**: `.env.test` must **NEVER** override `TEST_DB_SUFFIX`. `TEST_DB_SUFFIX` is a machine/worktree-local configuration defined in `.env.local` to isolate parallel test database clusters. Because `.env.test` is committed to version control and shared across all worktrees, allowing `.env.test` to override `TEST_DB_SUFFIX` would break test isolation between parallel tracks.

### Automatic Resolution via `getTestDatabaseUrl`

The function `getTestDatabaseUrl(packageName?: string)` in `@velvetai/db`:

1. Invokes `loadRootEnv({ isTest: true })` to guarantee worktree configuration is active.
2. Resolves the base connection URL from `process.env.TEST_DATABASE_URL` (falling back to `process.env.DATABASE_URL` or `postgresql://localhost:5432/velvetai_test?sslmode=disable`).
3. Detects the calling package via `packageName` parameter, `process.env.TEST_PACKAGE_NAME`, `process.env.npm_package_name`, or `process.cwd()`.
4. Derives the package-specific database name (e.g., `velvetai_test_api` or `velvetai_test_api_b`).
5. Verifies database safety invariants:
   - Throws immediately if connected to development databases (`velvetai`, `velvetai_b`, `velvet_dev`, `velvet_development`).
   - Requires database name to end with `_test` or contain the safe marker `_test_`.

### Intra-Package Sequential Execution

In packages with stateful database operations (`@velvetai/db`, `@velvetai/application`, `apps/api`, `apps/worker`), `fileParallelism: false` is configured in `vitest.config.ts`. This ensures test files within the same package execute sequentially, preventing intra-package fixture pollution while allowing full inter-package concurrency across Turborepo.

---

## 2. Local Database & Service Architecture

### Local PostgreSQL 17 (Homebrew)

Local development and automated test databases run on **Homebrew PostgreSQL 17** (`brew services postgresql@17`) listening on `127.0.0.1:5432` / `[::1]:5432`.

- `max_connections` is configured to **400** to sustain burst concurrency testing (100+ concurrent clients) alongside Turborepo's parallel multi-package test execution.
- Docker is used exclusively for Redis 7 (`docker compose up -d redis`).
- The `postgres` service in `docker-compose.yml` is optional and must **not** run simultaneously with Homebrew PostgreSQL to avoid port 5432 collision.

---

## 3. Test Environment Answers & Invariants

### Q1: Does `.env.test` contain a password?

**No.** `.env.test` is committed to version control and contains zero secrets or passwords:

```env
NODE_ENV=test
DATABASE_URL=postgresql://localhost:5432/velvetai_test?sslmode=disable
TEST_DATABASE_URL=postgresql://localhost:5432/velvetai_test?sslmode=disable
OIDC_MOCK_ENABLED=true
```

Local development and CI environments connect via trust/local socket on port 5432. If a custom PostgreSQL host/password is used in CI, it is provisioned through standard environment variables (`TEST_DATABASE_URL`).

### Q2: Single Preparation Command

A single command prepares all test databases from a fresh clone:

```bash
pnpm db:test:prepare
```

This script (`scripts/prepare-test-db.ts`):

1. Loads the root environment via `loadRootEnv({ isTest: true })`.
2. Connects to the PostgreSQL maintenance database.
3. Creates any missing test databases (including suffixed variants like `velvetai_test_api_b` if `TEST_DB_SUFFIX` is set).
4. Runs all Kysely database migrations up to the latest version on each database.

### Q3: Migration Lifecycle Test Isolation

The only test that runs down migrations is `packages/db/src/__tests__/migration-lifecycle.test.ts`. To ensure it cannot interfere with other tests:

1. It is bound specifically to `velvetai_test_migration` using `getTestDatabaseUrl("migration")`.
2. It operates entirely isolated from all other packages and from other `@velvetai/db` tests.
3. Tests in `@velvetai/db` run with `fileParallelism: false`.
