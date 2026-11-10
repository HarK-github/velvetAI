import { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { Kysely } from "kysely";
import { Database } from "@velvetai/db";
import { createProblemDetails, TenantId, UserId } from "@velvetai/contracts";
import { requireScopes } from "../plugins/auth.js";
import {
  JUDGE_TENANT_ID,
  JudgeAbuseLabService,
  JudgeAbuseRateLimitError,
} from "../judge/abuse-lab-runner.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JudgeAbuseLabPluginOptions {
  db?: Kysely<Database>;
  abuseLabService?: JudgeAbuseLabService;
}

let judgeAbuseLabDb: Kysely<Database> | null = null;

export function setJudgeAbuseLabDb(db: Kysely<Database>): void {
  judgeAbuseLabDb = db;
}

function isM2mPrincipal(subject: string, roles: readonly string[]): boolean {
  return subject.endsWith("@clients") || subject.startsWith("client|") || roles.includes("M2M");
}

function rejectNonJudge(
  reply: FastifyReply,
  requestUrl: string,
  requestId: string,
  principal: { subject: string; roles: string[]; tenantId: string },
): FastifyReply | null {
  if (isM2mPrincipal(principal.subject, principal.roles)) {
    const problem = createProblemDetails({
      title: "Forbidden",
      status: 403,
      code: "HUMAN_JUDGE_REQUIRED",
      requestId,
      detail: "M2M tokens are not permitted on judge abuse-lab endpoints.",
    });
    return reply
      .status(403)
      .header("content-type", "application/problem+json")
      .send({ ...problem, instance: requestUrl });
  }

  if (principal.tenantId !== JUDGE_TENANT_ID) {
    const problem = createProblemDetails({
      title: "Forbidden",
      status: 403,
      code: "UNAUTHORIZED_TENANT_ACCESS",
      requestId,
      detail: "Judge abuse-lab endpoints may only run in the dedicated judge tenant.",
    });
    return reply
      .status(403)
      .header("content-type", "application/problem+json")
      .send({ ...problem, instance: requestUrl });
  }

  return null;
}

export const judgeAbuseLabRoutes: FastifyPluginAsync<JudgeAbuseLabPluginOptions> = async (
  fastify: FastifyInstance,
  options: JudgeAbuseLabPluginOptions,
) => {
  let boundService: JudgeAbuseLabService | null = options.abuseLabService ?? null;

  const getService = (): JudgeAbuseLabService => {
    if (boundService) {
      return boundService;
    }
    const db = options.db ?? judgeAbuseLabDb;
    if (!db) {
      throw new Error("Database not initialized for judge abuse-lab routes");
    }
    boundService = new JudgeAbuseLabService(db, fastify);
    return boundService;
  };

  fastify.post(
    "/v1/judge/abuse-lab/runs",
    { preHandler: [requireScopes("judge:abuse_lab")] },
    async (request, reply) => {
      const principal = request.principal!;
      const rejected = rejectNonJudge(reply, request.url, request.id, principal);
      if (rejected) {
        return rejected;
      }

      try {
        const result = await getService().startRun({
          tenantId: principal.tenantId,
          actor: {
            subject: principal.subject,
            userId: principal.userId as UserId,
            tenantId: principal.tenantId as TenantId,
            roles: principal.roles,
          },
          authHeader: request.headers.authorization,
        });
        return reply.status(202).send(result);
      } catch (err: unknown) {
        if (err instanceof JudgeAbuseRateLimitError) {
          const problem = createProblemDetails({
            title: "Too Many Requests",
            status: 429,
            code: err.code,
            requestId: request.id,
            detail: err.message,
          });
          return reply
            .status(429)
            .header("retry-after", String(err.retryAfterSeconds))
            .header("content-type", "application/problem+json")
            .send({ ...problem, instance: request.url });
        }
        throw err;
      }
    },
  );

  fastify.get(
    "/v1/judge/abuse-lab/runs",
    { preHandler: [requireScopes("judge:abuse_lab")] },
    async (request, reply) => {
      const principal = request.principal!;
      const rejected = rejectNonJudge(reply, request.url, request.id, principal);
      if (rejected) {
        return rejected;
      }

      const payload = await getService().listRuns(principal.tenantId);
      return reply.status(200).send(payload);
    },
  );

  fastify.get<{ Params: { runId: string } }>(
    "/v1/judge/abuse-lab/runs/:runId",
    { preHandler: [requireScopes("judge:abuse_lab")] },
    async (request, reply) => {
      const principal = request.principal!;
      const rejected = rejectNonJudge(reply, request.url, request.id, principal);
      if (rejected) {
        return rejected;
      }

      const { runId } = request.params;
      if (!UUID_REGEX.test(runId)) {
        const problem = createProblemDetails({
          title: "Bad Request",
          status: 400,
          code: "invalid_run_id",
          requestId: request.id,
          detail: "runId must be a valid UUID.",
        });
        return reply
          .status(400)
          .header("content-type", "application/problem+json")
          .send({ ...problem, instance: request.url });
      }

      const run = await getService().getRun(principal.tenantId, runId);
      if (!run) {
        const problem = createProblemDetails({
          title: "Not Found",
          status: 404,
          code: "abuse_run_not_found",
          requestId: request.id,
          detail: `Live abuse-lab run ${runId} was not found in the judge tenant.`,
        });
        return reply
          .status(404)
          .header("content-type", "application/problem+json")
          .send({ ...problem, instance: request.url });
      }

      return reply.status(200).send(run);
    },
  );
};
