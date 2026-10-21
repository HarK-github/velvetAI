import { FastifyPluginAsync } from "fastify";
import {
  AvailabilityResponse,
  AvailableSlot,
  Rfc3339Timestamp,
  IanaTimeZone,
  ResourceId,
  CurrencyCode,
  MoneyMinor,
} from "@velvetai/contracts";

export const availabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/v1/availability", async (request, reply) => {
    const query = request.query as {
      serviceId?: string;
      locationId?: string;
      from?: string;
      to?: string;
      timeZone?: string;
    };

    const timeZone = (query.timeZone || "UTC") as IanaTimeZone;
    const serviceId = query.serviceId || "01932b10-0001-7000-8000-000000000001";

    // Generate deterministic available slots for today
    const baseHour = 9; // 09:00 AM
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), baseHour, 0, 0),
    );

    const slotOffsetsMinutes = [0, 90, 180, 270, 360, 450]; // 09:00, 10:30, 12:00, 13:30, 15:00, 16:30

    // Price minor mappings based on service
    const priceMap: Record<string, { price: number; deposit: number }> = {
      "01932b10-0001-7000-8000-000000000001": { price: 7500, deposit: 2000 },
      "01932b10-0001-7000-8000-000000000002": { price: 12000, deposit: 3500 },
      "01932b10-0001-7000-8000-000000000003": { price: 16000, deposit: 5000 },
    };

    const servicePricing = priceMap[serviceId] || { price: 7500, deposit: 2000 };

    const slots: AvailableSlot[] = slotOffsetsMinutes.map((offset, idx) => {
      const slotStart = new Date(today.getTime() + offset * 60 * 1000);
      const slotEnd = new Date(slotStart.getTime() + 45 * 60 * 1000);

      const hours = String(slotStart.getUTCHours()).padStart(2, "0");
      const minutes = String(slotStart.getUTCMinutes()).padStart(2, "0");

      return {
        startsAt: slotStart.toISOString() as Rfc3339Timestamp,
        endsAt: slotEnd.toISOString() as Rfc3339Timestamp,
        localStartsAt: `${hours}:${minutes}`,
        timeZone,
        resourceId: `01932b10-0004-7000-8000-00000000000${(idx % 2) + 1}` as ResourceId,
        price: {
          valueMinor: String(servicePricing.price) as MoneyMinor,
          currency: "USD" as CurrencyCode,
        },
        depositPreview: {
          valueMinor: String(servicePricing.deposit) as MoneyMinor,
          currency: "USD" as CurrencyCode,
        },
        fillProbability: Math.round((0.65 + (idx % 3) * 0.12) * 100) / 100,
        forecastConfidence: idx % 2 === 0 ? "high" : "medium",
      };
    });

    const response: AvailabilityResponse = {
      scheduleRevision: 14,
      generatedAt: new Date().toISOString() as Rfc3339Timestamp,
      slots,
    };

    return reply.status(200).send(response);
  });
};
