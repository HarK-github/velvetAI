import { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { Kysely } from "kysely";
import { Database } from "@velvetai/db";
import { createProblemDetails } from "@velvetai/contracts";
import { BookingProofService } from "@velvetai/application";
import { requireScopes } from "../plugins/auth.js";

const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JudgeProofPluginOptions {
  db?: Kysely<Database>;
}

let judgeProofDb: Kysely<Database> | null = null;

export function setJudgeProofDb(db: Kysely<Database>): void {
  judgeProofDb = db;
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
      detail: "M2M tokens are not permitted on judge proof endpoints.",
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
      detail: "Judge proof endpoints may only query bookings in the dedicated judge tenant.",
    });
    return reply
      .status(403)
      .header("content-type", "application/problem+json")
      .send({ ...problem, instance: requestUrl });
  }

  return null;
}

export const judgeProofRoutes: FastifyPluginAsync<JudgeProofPluginOptions> = async (
  fastify: FastifyInstance,
  options: JudgeProofPluginOptions,
) => {
  fastify.get<{ Params: { bookingId: string } }>(
    "/v1/judge/bookings/:bookingId/proof",
    { preHandler: [requireScopes("judge:proof")] },
    async (request, reply) => {
      const principal = request.principal!;
      const rejected = rejectNonJudge(reply, request.url, request.id, principal);
      if (rejected) {
        return rejected;
      }

      const { bookingId } = request.params;
      if (!UUID_REGEX.test(bookingId)) {
        const problem = createProblemDetails({
          title: "Bad Request",
          status: 400,
          code: "INVALID_BOOKING_ID",
          requestId: request.id,
          detail: "bookingId must be a valid UUID.",
        });
        return reply
          .status(400)
          .header("content-type", "application/problem+json")
          .send({ ...problem, instance: request.url });
      }

      const db = options.db ?? judgeProofDb;
      if (!db) {
        throw new Error("Database not initialized for judge proof routes");
      }

      const service = new BookingProofService(db);
      const proof = await service.getBookingProof(principal.tenantId, bookingId);
      return reply.status(200).send(proof);
    },
  );
};
