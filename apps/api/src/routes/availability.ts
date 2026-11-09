import "../env-loader.js";
import { FastifyPluginAsync } from "fastify";
import { TenantId, ServiceId, LocationId, IanaTimeZone } from "@velvetai/contracts";
import { AvailabilityService } from "@velvetai/application";
import { createDatabaseClient } from "@velvetai/db";
import { JUDGE_TENANT_ID } from "@velvetai/domain";
import {
  getClientIp,
  checkPublicRateLimit,
  getPublicRateLimitRetryAfter,
} from "../plugins/public-rate-limit.js";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);

let availabilityService = new AvailabilityService(db);

export function setAvailabilityService(service: AvailabilityService) {
  availabilityService = service;
}

export { availabilityService };

export const availabilityRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/availability - Authoritative PostgreSQL-backed availability calculation (public or authenticated)
  app.get("/v1/availability", async (request, reply) => {
    const query = request.query as {
      serviceId?: string;
      locationId?: string;
      from?: string;
      to?: string;
      timeZone?: string;
      tenant_id?: string;
      tenantId?: string;
    };

    let tenantId: TenantId;

    if (!request.principal) {
      // Unauthenticated public request
      if (
        query.tenant_id ||
        query.tenantId ||
        request.headers["x-tenant-id"] ||
        request.headers["tenant-id"]
      ) {
        return reply.status(400).send({
          type: "https://errors.velvetai.com/bad-request",
          title: "Bad Request",
          status: 400,
          code: "tenant_override_forbidden",
          detail: "Tenant override is forbidden for unauthenticated requests",
        });
      }

      const clientIp = getClientIp(request);
      if (!checkPublicRateLimit(clientIp)) {
        const retryAfter = getPublicRateLimitRetryAfter(clientIp);
        return reply
          .status(429)
          .header("Retry-After", String(retryAfter))
          .send({
            type: "https://errors.velvetai.com/rate-limit-exceeded",
            title: "Rate Limit Exceeded",
            status: 429,
            code: "rate_limit_exceeded",
            detail: `Rate limit exceeded for unauthenticated requests (max 60 per minute). Retry after ${retryAfter}s.`,
            retryAfter,
          });
      }

      tenantId = (process.env.PUBLIC_DEMO_TENANT_ID || JUDGE_TENANT_ID) as TenantId;
    } else {
      tenantId = (request.tenantId || request.principal.tenantId) as TenantId;
    }

    if (!query.serviceId) {
      return reply.status(400).send({
        type: "https://errors.velvetai.com/bad-request",
        title: "Missing Required Parameter",
        status: 400,
        detail: "serviceId is required for availability query",
      });
    }

    const fromDate = query.from ? new Date(query.from) : undefined;
    const toDate = query.to ? new Date(query.to) : undefined;

    const result = await availabilityService.getAvailability({
      tenantId,
      serviceId: query.serviceId as ServiceId,
      locationId: query.locationId as LocationId | undefined,
      from: fromDate,
      to: toDate,
      timeZone: query.timeZone as IanaTimeZone | undefined,
    });

    return reply.status(200).send(result);
  });
};
