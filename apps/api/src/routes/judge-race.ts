import "../env-loader.js";
import { FastifyPluginAsync, FastifyReply } from "fastify";
import { Kysely } from "kysely";
import { createDatabaseClient, Database } from "@velvetai/db";
import { JudgeRaceTestService, RaceTestRateLimitError } from "@velvetai/application";
import { createProblemDetails, raceTestInputSchema, TenantId, UserId } from "@velvetai/contracts";
import { JUDGE_TENANT_ID } from "@velvetai/domain";
import { requireScopes } from "../plugins/auth.js";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";

export interface JudgeRacePluginOptions {
  db?: Kysely<Database>;
  raceTestService?: JudgeRaceTestService;
}

let judgeRaceDb: Kysely<Database> = createDatabaseClient(databaseUrl);

export function setJudgeRaceDb(db: Kysely<Database>): void {
  judgeRaceDb = db;
}

function rejectNonJudge(
  reply: FastifyReply,
  requestUrl: string,
  requestId: string,
  principal: { subject: string; roles: string[]; tenantId: string },
): FastifyReply | null {
  if (
    principal.subject.endsWith("@clients") ||
    principal.subject.startsWith("client|") ||
    principal.roles.includes("M2M")
  ) {
    return reply
      .status(403)
      .header("content-type", "application/problem+json")
      .send({
        ...createProblemDetails({
          title: "Forbidden",
          status: 403,
          code: "HUMAN_JUDGE_REQUIRED",
          requestId,
          detail: "M2M tokens are not permitted on judge race-test endpoints.",
        }),
        instance: requestUrl,
      });
  }

  if (principal.tenantId !== JUDGE_TENANT_ID) {
    return reply
      .status(403)
      .header("content-type", "application/problem+json")
      .send({
        ...createProblemDetails({
          title: "Forbidden",
          status: 403,
          code: "UNAUTHORIZED_TENANT_ACCESS",
          requestId,
          detail: "Judge race-test endpoints may only run in the dedicated judge tenant.",
        }),
        instance: requestUrl,
      });
  }

  return null;
}

export const judgeRaceRoutes: FastifyPluginAsync<JudgeRacePluginOptions> = async (
  fastify,
  options,
) => {
  let boundService: JudgeRaceTestService | null = options.raceTestService ?? null;

  const getService = (): JudgeRaceTestService => {
    if (boundService) {
      return boundService;
    }
    boundService = new JudgeRaceTestService(options.db ?? judgeRaceDb);
    return boundService;
  };

  fastify.post(
    "/v1/judge/race-test",
    { preHandler: [requireScopes("judge:abuse_lab")] },
    async (request, reply) => {
      const principal = request.principal!;
      const rejected = rejectNonJudge(reply, request.url, request.id, principal);
      if (rejected) {
        return rejected;
      }

      const parsed = raceTestInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .header("content-type", "application/problem+json")
          .send(
            createProblemDetails({
              title: "Bad Request",
              status: 400,
              code: "invalid_request_schema",
              requestId: request.id,
              detail: "Invalid race-test request parameters.",
              invalidParams: parsed.error.issues.map((issue) => ({
                name: issue.path.join(".") || "body",
                reason: issue.message,
              })),
            }),
          );
      }

      try {
        const result = await getService().runRaceTest({
          tenantId: principal.tenantId,
          actor: {
            subject: principal.subject,
            userId: principal.userId as UserId,
            tenantId: principal.tenantId as TenantId,
            roles: principal.roles,
          },
          params: parsed.data,
        });
        return reply.status(200).send(result);
      } catch (err: unknown) {
        if (err instanceof RaceTestRateLimitError) {
          return reply
            .status(429)
            .header("Retry-After", String(err.retryAfterSeconds))
            .header("content-type", "application/problem+json")
            .send({
              ...createProblemDetails({
                title: "Too Many Requests",
                status: 429,
                code: err.code,
                requestId: request.id,
                detail: err.message,
              }),
              instance: request.url,
            });
        }
        throw err;
      }
    },
  );
};
