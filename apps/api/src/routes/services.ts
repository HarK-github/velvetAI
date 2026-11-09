import "../env-loader.js";
import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { ServiceId, TenantId } from "@velvetai/contracts";
import { CatalogService } from "@velvetai/application";
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

let catalogService = new CatalogService(db);

export function setCatalogService(service: CatalogService) {
  catalogService = service;
}

export { catalogService };

function resolveTenantForRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): { tenantId: TenantId } | { errorResponse: true } {
  // Unauthenticated public request
  if (!request.principal) {
    const query = (request.query || {}) as Record<string, string | undefined>;
    if (
      query.tenant_id ||
      query.tenantId ||
      request.headers["x-tenant-id"] ||
      request.headers["tenant-id"]
    ) {
      reply.status(400).send({
        type: "https://errors.velvetai.com/bad-request",
        title: "Bad Request",
        status: 400,
        code: "tenant_override_forbidden",
        detail: "Tenant override is forbidden for unauthenticated requests",
      });
      return { errorResponse: true };
    }

    const clientIp = getClientIp(request);
    if (!checkPublicRateLimit(clientIp)) {
      const retryAfter = getPublicRateLimitRetryAfter(clientIp);
      reply
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
      return { errorResponse: true };
    }

    const publicTenantId = (process.env.PUBLIC_DEMO_TENANT_ID || JUDGE_TENANT_ID) as TenantId;
    return { tenantId: publicTenantId };
  }

  // Authenticated request derives tenant strictly from authenticated membership
  const tenantId = (request.tenantId || request.principal.tenantId) as TenantId;
  return { tenantId };
}

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/services - Authoritative PostgreSQL-backed catalog query (public or authenticated)
  app.get("/v1/services", async (request, reply) => {
    const resolved = resolveTenantForRequest(request, reply);
    if ("errorResponse" in resolved) return;

    const services = await catalogService.listServices(resolved.tenantId);

    return reply.status(200).send({
      services,
      total: services.length,
    });
  });

  // GET /v1/services/:id - Single service details (public or authenticated)
  app.get("/v1/services/:id", async (request, reply) => {
    const resolved = resolveTenantForRequest(request, reply);
    if ("errorResponse" in resolved) return;

    const { id } = request.params as { id: string };
    const service = await catalogService.getService(resolved.tenantId, id as ServiceId);
    if (!service) {
      return reply.status(404).send({
        type: "https://errors.velvetai.com/not-found",
        title: "Service Not Found",
        status: 404,
        detail: `Service ${id} not found for this tenant`,
      });
    }

    return reply.status(200).send(service);
  });
};
