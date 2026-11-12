import "../env-loader.js";
import { FastifyPluginAsync } from "fastify";
import { createProblemDetails, TenantId } from "@velvetai/contracts";
import { ScheduleService } from "@velvetai/application";
import { createDatabaseClient, Database, Kysely } from "@velvetai/db";
import { JUDGE_TENANT_ID } from "@velvetai/domain";
import {
  getClientIp,
  checkPublicRateLimit,
  getPublicRateLimitRetryAfter,
} from "../plugins/public-rate-limit.js";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
let scheduleDb: Kysely<Database> = createDatabaseClient(databaseUrl);
let scheduleService = new ScheduleService(scheduleDb);

export function setScheduleDb(customDb: Kysely<Database>): void {
  scheduleDb = customDb;
  scheduleService = new ScheduleService(customDb);
}

export function setScheduleService(service: ScheduleService): void {
  scheduleService = service;
}

function normalizeEtagValue(raw: string): string {
  return raw
    .trim()
    .replace(/^W\//i, "")
    .replace(/^"+|"+$/g, "");
}

function matchesIfNoneMatch(headerValue: string | string[] | undefined, revision: string): boolean {
  if (!headerValue) return false;
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  const candidates = raw.split(",").map((part) => normalizeEtagValue(part));
  return candidates.includes("*") || candidates.includes(revision);
}

function hasScheduleReadScope(scopes: readonly string[]): boolean {
  return scopes.includes("merchant:schedule") || scopes.some((scope) => scope.startsWith("judge:"));
}

export const scheduleRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/merchant/schedule - Bryntum Scheduler read model (authenticated or public demo read-only)
  app.get("/v1/merchant/schedule", async (request, reply) => {
    const query = (request.query || {}) as {
      from?: string;
      to?: string;
      public?: string;
      tenant_id?: string;
      tenantId?: string;
    };

    let tenantId: TenantId;

    if (!request.principal) {
      if (
        query.public === "false" ||
        query.tenant_id ||
        query.tenantId ||
        request.headers["x-tenant-id"] ||
        request.headers["tenant-id"]
      ) {
        return reply
          .status(400)
          .header("content-type", "application/problem+json")
          .send(
            createProblemDetails({
              title: "Bad Request",
              status: 400,
              code: "tenant_override_forbidden",
              requestId: request.id,
              detail:
                query.public === "false"
                  ? "Authentication required when public=false"
                  : "Tenant override is forbidden for unauthenticated requests",
            }),
          );
      }

      const clientIp = getClientIp(request);
      if (!checkPublicRateLimit(clientIp)) {
        const retryAfter = getPublicRateLimitRetryAfter(clientIp);
        return reply
          .status(429)
          .header("Retry-After", String(retryAfter))
          .header("content-type", "application/problem+json")
          .send({
            ...createProblemDetails({
              title: "Rate Limit Exceeded",
              status: 429,
              code: "rate_limit_exceeded",
              requestId: request.id,
              detail: `Rate limit exceeded for unauthenticated requests (max 60 per minute). Retry after ${retryAfter}s.`,
            }),
            retryAfter,
          });
      }

      tenantId = (process.env.PUBLIC_DEMO_TENANT_ID || JUDGE_TENANT_ID) as TenantId;
    } else {
      const scopes = request.principal.scopes || [];
      if (!hasScheduleReadScope(scopes)) {
        return reply
          .status(403)
          .header("content-type", "application/problem+json")
          .send(
            createProblemDetails({
              title: "Forbidden",
              status: 403,
              code: "insufficient_scope",
              requestId: request.id,
              detail: "Missing required scope: merchant:schedule or judge",
            }),
          );
      }

      tenantId = (request.tenantId || request.principal.tenantId) as TenantId;
    }

    const now = new Date();
    const defaultFrom = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const defaultTo = new Date(defaultFrom.getTime() + 2 * 24 * 60 * 60_000);

    const fromDate = query.from ? new Date(query.from) : defaultFrom;
    const toDate = query.to ? new Date(query.to) : defaultTo;

    if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime())) {
      return reply
        .status(400)
        .header("content-type", "application/problem+json")
        .send(
          createProblemDetails({
            title: "Bad Request",
            status: 400,
            code: "INVALID_SCHEDULE_RANGE",
            requestId: request.id,
            detail: "Invalid 'from' or 'to' ISO timestamp for schedule query.",
          }),
        );
    }

    const schedule = await scheduleService.getSchedule({
      tenantId,
      from: fromDate,
      to: toDate,
    });

    const etag = `"${schedule.scheduleRevision}"`;
    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, no-cache");

    if (matchesIfNoneMatch(request.headers["if-none-match"], schedule.scheduleRevision)) {
      return reply.status(304).send();
    }

    return reply.status(200).send(schedule);
  });
};
