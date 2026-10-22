import "../env-loader.js";
import { FastifyPluginAsync } from "fastify";
import { ServiceId, TenantId } from "@velvetai/contracts";
import { CatalogService } from "@velvetai/application";
import { createDatabaseClient } from "@velvetai/db";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);

let catalogService = new CatalogService(db);

export function setCatalogService(service: CatalogService) {
  catalogService = service;
}

export { catalogService };

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/services - Authoritative PostgreSQL-backed catalog query
  app.get("/v1/services", async (request, reply) => {
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const services = await catalogService.listServices(tenantId);

    return reply.status(200).send({
      services,
      total: services.length,
    });
  });

  // GET /v1/services/:id - Single service details
  app.get("/v1/services/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);

    const service = await catalogService.getService(tenantId, id as ServiceId);
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
