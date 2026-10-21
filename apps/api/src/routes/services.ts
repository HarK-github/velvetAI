import { FastifyPluginAsync } from "fastify";
import {
  ServiceDTO,
  ServiceId,
  TenantId,
  ServiceVersionId,
  CancellationPolicyId,
  CurrencyCode,
  MoneyMinor,
} from "@velvetai/contracts";

export const MOCK_SERVICES: ServiceDTO[] = [
  {
    id: "01932b10-0001-7000-8000-000000000001" as ServiceId,
    tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
    status: "ACTIVE",
    currentVersionId: "01932b10-0002-7000-8000-000000000001" as ServiceVersionId,
    versions: [
      {
        id: "01932b10-0002-7000-8000-000000000001" as ServiceVersionId,
        tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
        serviceId: "01932b10-0001-7000-8000-000000000001" as ServiceId,
        version: 1,
        name: "Executive Haircut & Beard Sculpt",
        description:
          "Precision razor fade, hot towel treatment, and beard oil hydration conditioning.",
        durationMinutes: 45,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 15,
        priceMinor: "7500" as MoneyMinor,
        baseDepositMinor: "2000" as MoneyMinor,
        currency: "USD" as CurrencyCode,
        cancellationPolicyId: "01932b10-0003-7000-8000-000000000001" as CancellationPolicyId,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: "01932b10-0001-7000-8000-000000000002" as ServiceId,
    tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
    status: "ACTIVE",
    currentVersionId: "01932b10-0002-7000-8000-000000000002" as ServiceVersionId,
    versions: [
      {
        id: "01932b10-0002-7000-8000-000000000002" as ServiceVersionId,
        tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
        serviceId: "01932b10-0001-7000-8000-000000000002" as ServiceId,
        version: 1,
        name: "Deep Tissue & Mobility Session",
        description: "Neuromuscular therapy, targeted percussion, and guided joint decompression.",
        durationMinutes: 60,
        bufferBeforeMinutes: 5,
        bufferAfterMinutes: 10,
        priceMinor: "12000" as MoneyMinor,
        baseDepositMinor: "3500" as MoneyMinor,
        currency: "USD" as CurrencyCode,
        cancellationPolicyId: "01932b10-0003-7000-8000-000000000002" as CancellationPolicyId,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  {
    id: "01932b10-0001-7000-8000-000000000003" as ServiceId,
    tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
    status: "ACTIVE",
    currentVersionId: "01932b10-0002-7000-8000-000000000003" as ServiceVersionId,
    versions: [
      {
        id: "01932b10-0002-7000-8000-000000000003" as ServiceVersionId,
        tenantId: "01932b10-0000-7000-8000-000000000001" as TenantId,
        serviceId: "01932b10-0001-7000-8000-000000000003" as ServiceId,
        version: 1,
        name: "Private Acoustic Studio Block",
        description:
          "Isolated acoustic tracking room, Neumann microphones, and direct monitoring desk.",
        durationMinutes: 120,
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
        priceMinor: "16000" as MoneyMinor,
        baseDepositMinor: "5000" as MoneyMinor,
        currency: "USD" as CurrencyCode,
        cancellationPolicyId: "01932b10-0003-7000-8000-000000000003" as CancellationPolicyId,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
];

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/services", async (_request, reply) => {
    const serialized = MOCK_SERVICES.map((s) => ({
      ...s,
      versions: s.versions?.map((v) => ({
        ...v,
        priceMinor: Number(v.priceMinor),
        baseDepositMinor: Number(v.baseDepositMinor),
      })),
    }));

    return reply.status(200).send({
      services: serialized,
      total: serialized.length,
    });
  });
};
