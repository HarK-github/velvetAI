# P1 — Parallel Tracks Setup (run right after S0, same chat)

Read `prompts/epic5/00_OPERATING_RULES.md` first. Time box: 1.5 hours.

## Goal

Two coding chats will work at the same time on two branches in two folders (git worktrees):

| Track        | Folder                          | Branch               | Owns                                                                                              |
| ------------ | ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| A — platform | `~/Documents/github/velvetAI`   | `feat/epic5-track-a` | Render, judge tenant/reset, Abuse Lab live runs + /security, proof panel, fault injection, /judge |
| B — product  | `~/Documents/github/velvetAI-b` | `feat/epic5-track-b` | Approval page + pay, Bryntum scheduler, forecasting, UI polish                                    |

They must not collide on ports, Docker containers, the development database, or the per-package test databases. This setup makes that possible. No product features in this step.

## Task 1 — Make local ports and database names configurable

Change only what is needed, keep current defaults for track A:

1. `docker-compose.yml`:
   - Host ports from env with defaults: `"${POSTGRES_PORT:-5432}:5432"`, `"${REDIS_PORT:-6379}:6379"`.
   - Keep the `max_connections` change from S0.
   - Containers must not have hardcoded `container_name` values (remove them if present) so `COMPOSE_PROJECT_NAME` separates the two stacks. Volumes are then per project automatically.
2. API port already comes from `PORT`; confirm. Web dev port: `apps/web/vite.config.ts` uses `Number(process.env.WEB_PORT ?? 5173)` with `strictPort: true`.
3. Test databases: `getTestDatabaseUrl()` (or the per-package vitest configs) must derive names with an optional suffix: `velvetai_test_api${TEST_DB_SUFFIX ?? ""}` etc. `pnpm db:test:prepare` creates/migrates the suffixed names. The `_test` safety guards must still pass (suffix like `_b` keeps `_test_` in the name: `velvetai_test_api_b`).
4. Test DB host/port come from the same env used by the dev DB (so track B tests hit its own Postgres on 5433).
5. Add tests: `assertSafeTestDatabaseUrl` accepts `velvetai_test_api_b`; rejects `velvetai_b`.

Run the full verification set on track A defaults. Commit on `main`? No — commit on a short branch `chore/parallel-tracks`, then ask me before merging to main (fast-forward or a merge commit is fine here).

## Task 2 — Branches and worktree (after I approve the merge)

```zsh
cd ~/Documents/github/velvetAI
git switch main && git pull --ff-only
git switch -c feat/epic5-track-a && git push -u origin feat/epic5-track-a
git branch feat/epic5-track-b main && git push -u origin feat/epic5-track-b
git worktree add ../velvetAI-b feat/epic5-track-b
```

## Task 3 — Track B environment (give me these exact steps; I run them)

```zsh
cd ~/Documents/github/velvetAI-b
cp ../velvetAI/.env .env
cp ../velvetAI/.env.local .env.local
```

Then I edit `.env.local` in track B with nano and set (you tell me exactly which existing lines to change, by variable name):

```text
COMPOSE_PROJECT_NAME=velvetai_b
POSTGRES_PORT=5433
REDIS_PORT=6380
PORT=3001
WEB_PORT=5174
TEST_DB_SUFFIX=_b
DATABASE_URL / TEST_DATABASE_URL: same as track A but port 5433
REDIS_URL: port 6380
API_BASE_URL=http://localhost:3001
WEB_BASE_URL=http://localhost:5174
VITE_API_BASE_URL=http://localhost:3001   (if used)
ALLOWED_ORIGINS: add http://localhost:5174
ALLOWED_HOSTS: add localhost:3001,127.0.0.1:3001
MCP_RESOURCE_URL: keep http://localhost:3000/mcp (track B does not run MCP smoke tests)
PUBLIC_WEB_ORIGIN=http://localhost:5174   (if the variable exists by then)
```

Tell me whether docker compose reads `COMPOSE_PROJECT_NAME`/ports from `.env` or `.env.local` in this repo (it reads `.env` by default). If only `.env` is read by compose, tell me to put the compose variables into track B's `.env` instead.

Auth0 (I do it): velvetAI Web SPA → Settings → add `http://localhost:5174` to Allowed Callback URLs, Allowed Logout URLs, Allowed Web Origins → Save.

Then in track B:

```zsh
mise exec -- pnpm install --frozen-lockfile
docker compose up -d
docker compose ps                # velvetai_b-postgres-1 etc. on 5433/6380
mise exec -- pnpm db:migrate
mise exec -- pnpm dev:catalog:confirm     # seeds the dev catalog into track B's own DB
mise exec -- pnpm auth:provision-test-user   # same Auth0 test user, track B DB
mise exec -- pnpm db:test:prepare
mise exec -- pnpm turbo run test --force
```

## Task 4 — Prove isolation

1. Run `pnpm turbo run test --force` in track A and track B at the same time (two terminals). Both green. Report durations.
2. Both dev stacks running at once: track A web 5173/API 3000, track B web 5174/API 3001. Sign in on both. Ask AI works on both.

## Task 5 — Collaboration rules (write into `prompts/epic5/PARALLEL_RULES.md` and commit to main)

```markdown
# Parallel track rules

1. Each track only edits files for its own work packages. Shared files (route registration, idempotency route list, tool registry, error code enum, contracts index, docs/implementation-progress.md, docs/epic5-checklist.md) may be edited by both: keep edits small and additive (append, don't reorder).
2. Migration numbers are reserved:
   - 0006 — WP 02 approval (track B, only if needed)
   - 0007 — WP 04 judge tenant (track A)
   - 0008 — WP 06 forecasting (track B)
   - 0009 — WP 07 abuse runs (track A)
   - 0010 — WP 08 fault flags (track A)
     If a reserved migration isn't needed, leave the number unused.
3. Integration after every VERIFIED work package:
   a. In the track folder: `git fetch origin && git merge origin/main` (merge, not rebase). Resolve conflicts keeping BOTH sides' additions. Run the full verification set.
   b. Ask the user before: `git switch main && git pull --ff-only && git merge --no-ff feat/epic5-track-x && git push origin main`, then switch back to the track branch.
   c. Render deploys main automatically (after WP 03). Verify the hosted site after each merge.
4. Never force-push. Never rebase a pushed branch.
5. Pull main into your track at least once per day even without finishing a package.
6. Only track A runs `pnpm mcp:smoke` and hosted PayPal tests; track B tests PayPal locally.
```

## Report

1. Files changed in Task 1 and test results.
2. Branches and worktree list (`git worktree list`, `git branch -vv`).
3. Track B env steps given to the user.
4. Isolation proof (both test runs, both stacks).
5. PARALLEL_RULES.md committed SHA on main.
