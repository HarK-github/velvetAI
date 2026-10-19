import { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { generateUuidV7 } from "@velvetai/contracts";

// In-memory hold store for local development and live frontend preview
interface HoldRecord {
  bookingId: string;
  quoteId: string;
  customerEmail: string;
  status: "HELD" | "CONFIRMED" | "EXPIRED";
  holdExpiresAt: string;
  createdAt: string;
  signedIntent: string;
  version: number;
}

const activeHolds = new Map<string, HoldRecord>();

function createSignedIntent(
  payload: Record<string, unknown>,
  secret = "velvet-secret-key-32-bytes-long!",
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/booking-quotes
  app.post("/v1/booking-quotes", async (request, reply) => {
    const body =
      (request.body as {
        serviceId?: string;
        locationId?: string;
        startsAt?: string;
        timeZone?: string;
      }) || {};

    const serviceId = body.serviceId || "01932b10-0001-7000-8000-000000000001";
    const quoteId = generateUuidV7();
    const now = Date.now();
    const expiresAt = new Date(now + 15 * 60 * 1000).toISOString(); // 15 min quote validity

    const pricingTable: Record<string, { total: number; deposit: number; summary: string }> = {
      "01932b10-0001-7000-8000-000000000001": {
        total: 7500,
        deposit: 2000,
        summary: "100% deposit refund until 24 hours before appointment.",
      },
      "01932b10-0001-7000-8000-000000000002": {
        total: 12000,
        deposit: 3500,
        summary: "Full deposit refund up to 48 hours prior; 50% thereafter.",
      },
      "01932b10-0001-7000-8000-000000000003": {
        total: 16000,
        deposit: 5000,
        summary: "Non-refundable deposit within 72 hours of session start.",
      },
    };

    const quoteDetails = pricingTable[serviceId] || {
      total: 7500,
      deposit: 2000,
      summary: "Standard 24-hour cancellation policy applies.",
    };

    return reply.status(201).send({
      quoteId,
      expiresAt,
      serviceVersion: 1,
      scheduleRevision: 14,
      total: {
        valueMinor: quoteDetails.total,
        currency: "USD",
      },
      deposit: {
        valueMinor: quoteDetails.deposit,
        currency: "USD",
      },
      risk: {
        noShowProbability: 0.08,
        band: "low",
        confidence: "high",
        modelVersion: "v1.4.0-calibrated",
      },
      cancellationPolicy: {
        policyId: "01932b10-0003-7000-8000-000000000001",
        version: 1,
        summary: quoteDetails.summary,
      },
    });
  });

  // POST /v1/booking-holds
  app.post("/v1/booking-holds", async (request, reply) => {
    const body =
      (request.body as {
        quoteId?: string;
        customer?: { email: string; displayName?: string };
        note?: string;
      }) || {};

    const quoteId = body.quoteId || generateUuidV7();
    const customerEmail = body.customer?.email || "guest@velvetai.internal";
    const bookingId = generateUuidV7();

    const now = Date.now();
    // 300 seconds hold TTL as specified in spec.md
    const holdExpiresAt = new Date(now + 300 * 1000).toISOString();

    const signedIntent = createSignedIntent({
      sub: bookingId,
      quoteId,
      email: customerEmail,
      holdExpiresAt,
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + 300 * 1000) / 1000),
    });

    const holdRecord: HoldRecord = {
      bookingId,
      quoteId,
      customerEmail,
      status: "HELD",
      holdExpiresAt,
      createdAt: new Date(now).toISOString(),
      signedIntent,
      version: 1,
    };

    activeHolds.set(bookingId, holdRecord);

    return reply.status(201).send({
      bookingId,
      status: "HELD",
      holdExpiresAt,
      version: 1,
      signedIntent,
    });
  });

  // GET /v1/bookings/:id
  app.get("/v1/bookings/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = activeHolds.get(id);

    if (!record) {
      return reply.status(404).send({
        title: "Booking Not Found",
        status: 404,
        code: "booking_not_found",
        detail: `No active booking found for id ${id}`,
      });
    }

    // Check if expired
    const isExpired = Date.now() > new Date(record.holdExpiresAt).getTime();
    if (isExpired && record.status === "HELD") {
      record.status = "EXPIRED";
    }

    return reply.status(200).send(record);
  });
};
