import { FastifyPluginAsync } from "fastify";
import { JudgeResetService } from "@velvetai/application";
import { createDatabaseClient, sql, Database, Kysely } from "@velvetai/db";
import { JUDGE_TENANT_ID, JudgeResetInProgressError } from "@velvetai/domain";
import { createProblemDetails } from "@velvetai/contracts";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
let db: Kysely<Database> = createDatabaseClient(databaseUrl);
let judgeResetService = new JudgeResetService(db);

export function setJudgeDb(customDb: Kysely<Database>) {
  db = customDb;
  judgeResetService = new JudgeResetService(customDb);
}

export function setJudgeResetService(service: JudgeResetService) {
  judgeResetService = service;
}

export const judgeRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/judge/reset: Trigger deterministic judge tenant reset
  app.post("/v1/judge/reset", async (request, reply) => {
    // 1. Authentication Check
    if (!request.headers.authorization) {
      const problem = createProblemDetails({
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        requestId: request.id,
        detail: "Authentication credentials missing or invalid",
      });
      return reply.status(401).header("content-type", "application/problem+json").send(problem);
    }

    const principal = request.principal;
    if (!principal) {
      const problem = createProblemDetails({
        title: "Unauthorized",
        status: 401,
        code: "unauthorized",
        requestId: request.id,
        detail: "Authentication credentials missing or invalid",
      });
      return reply.status(401).header("content-type", "application/problem+json").send(problem);
    }

    // 2. Machine-to-machine / agent rejection
    if (
      principal.subject.endsWith("@clients") ||
      principal.subject.startsWith("client|") ||
      principal.roles.includes("M2M" as any)
    ) {
      const problem = createProblemDetails({
        title: "Forbidden",
        status: 403,
        code: "forbidden",
        requestId: request.id,
        detail: "Machine-to-machine clients cannot invoke judge reset. Human judge user required.",
      });
      return reply.status(403).header("content-type", "application/problem+json").send(problem);
    }

    // 3. Permission / Scope Check
    const userScopes = principal.scopes || [];
    if (!userScopes.includes("judge:reset")) {
      const problem = createProblemDetails({
        title: "Forbidden",
        status: 403,
        code: "insufficient_scope",
        requestId: request.id,
        detail: "Missing required scope: judge:reset",
      });
      return reply.status(403).header("content-type", "application/problem+json").send(problem);
    }

    // 4. Tenant Isolation Guard
    const requestTenantId = request.tenantId || principal.tenantId;
    if (requestTenantId !== JUDGE_TENANT_ID) {
      const problem = createProblemDetails({
        title: "Forbidden",
        status: 403,
        code: "FORBIDDEN_TENANT_ACCESS",
        requestId: request.id,
        detail: `Judge reset is restricted strictly to the judge tenant (${JUDGE_TENANT_ID})`,
      });
      return reply.status(403).header("content-type", "application/problem+json").send(problem);
    }

    // 5. In-Progress Check (409)
    const activeRun = await db
      .selectFrom("judge_runs")
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .where("status", "=", "RUNNING")
      .where(sql<boolean>`started_at >= ${new Date(Date.now() - 5 * 60_000)}`)
      .select(["id", "started_at"])
      .executeTakeFirst();

    if (activeRun) {
      const problem = createProblemDetails({
        title: "Conflict",
        status: 409,
        code: "JUDGE_RESET_IN_PROGRESS",
        requestId: request.id,
        detail: "A judge reset run is currently in progress",
      });
      return reply.status(409).header("content-type", "application/problem+json").send(problem);
    }

    // 6. Rate Limit Check: 1 per 60s (429 with Retry-After)
    const latestRun = await db
      .selectFrom("judge_runs")
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .orderBy("started_at", "desc")
      .select(["id", "started_at"])
      .limit(1)
      .executeTakeFirst();

    if (latestRun) {
      const startedAtMs = new Date(latestRun.started_at).getTime();
      const elapsedSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
      if (elapsedSeconds < 60) {
        const retryAfter = 60 - elapsedSeconds;
        reply.header("Retry-After", retryAfter.toString());
        const problem = createProblemDetails({
          title: "Too Many Requests",
          status: 429,
          code: "rate_limit_exceeded",
          requestId: request.id,
          detail: `Judge reset is rate-limited to 1 per 60 seconds. Retry after ${retryAfter}s.`,
        });
        return reply.status(429).header("content-type", "application/problem+json").send(problem);
      }
    }

    // 7. Execute reset
    try {
      const result = await judgeResetService.resetJudgeTenant({
        tenantId: JUDGE_TENANT_ID,
        requestedBy: principal.userId,
      });

      return reply.status(202).send({
        runId: result.runId,
        status: "RUNNING",
        statusUrl: `/v1/judge/runs/${result.runId}`,
      });
    } catch (err: unknown) {
      if (err instanceof JudgeResetInProgressError) {
        const problem = createProblemDetails({
          title: "Conflict",
          status: 409,
          code: "JUDGE_RESET_IN_PROGRESS",
          requestId: request.id,
          detail: err.message,
        });
        return reply.status(409).header("content-type", "application/problem+json").send(problem);
      }
      throw err;
    }
  });

  // GET /v1/judge/runs/:runId: Fetch status and summary of a specific reset run
  app.get("/v1/judge/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = await judgeResetService.getRun(runId);

    if (!run) {
      const problem = createProblemDetails({
        title: "Not Found",
        status: 404,
        code: "run_not_found",
        requestId: request.id,
        detail: `Judge run with ID '${runId}' not found`,
      });
      return reply.status(404).header("content-type", "application/problem+json").send(problem);
    }

    return reply.status(200).send(run);
  });

  // GET /v1/judge/runs/latest: Fetch status and summary of latest run
  app.get("/v1/judge/runs/latest", async (request, reply) => {
    const latest = await judgeResetService.getLatestRun();

    if (!latest) {
      const problem = createProblemDetails({
        title: "Not Found",
        status: 404,
        code: "no_judge_runs",
        requestId: request.id,
        detail: "No judge reset runs have been executed yet",
      });
      return reply.status(404).header("content-type", "application/problem+json").send(problem);
    }

    return reply.status(200).send(latest);
  });
};
