import "../env-loader.js";
import { FastifyPluginAsync } from "fastify";
import { TenantId, ServiceId, LocationId, IanaTimeZone } from "@velvetai/contracts";
import { AvailabilityService } from "@velvetai/application";
import { createDatabaseClient } from "@velvetai/db";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);

let availabilityService = new AvailabilityService(db);

export function setAvailabilityService(service: AvailabilityService) {
  availabilityService = service;
}

export { availabilityService };

export const availabilityRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/availability - Authoritative PostgreSQL-backed availability calculation
  app.get("/v1/availability", async (request, reply) => {
    const query = request.query as {
      serviceId?: string;
      locationId?: string;
      from?: string;
      to?: string;
      timeZone?: string;
    };

    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);

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
