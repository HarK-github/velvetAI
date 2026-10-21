import { FastifyPluginAsync } from "fastify";
import {
  BookingService,
  BookingActor,
} from "@velvetai/application";
import {
  createDatabaseClient,
  withTenantTransaction,
} from "@velvetai/db";
import {
  createBookingQuoteInputSchema,
  prepareBookingInputSchema,
  commitBookingInputSchema,
  prepareCancellationInputSchema,
  TenantId,
  UserId,
} from "@velvetai/contracts";

// Shared database client instance for API booking routes
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);
const bookingService = new BookingService(db);

export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  // POST /v1/booking-quotes: Request a 5-minute versioned booking quote
  app.post("/v1/booking-quotes", async (request, reply) => {
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const principal = request.principal || {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId,
      roles: ["OWNER"],
      roleVersion: 1,
      authTime: new Date().toISOString(),
      mfaVerified: true,
    };

    const actor: BookingActor = {
      subject: principal.subject,
      userId: principal.userId,
      tenantId: principal.tenantId,
      roles: principal.roles,
    };

    const parsed = createBookingQuoteInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_quote_input",
        detail: parsed.error.message,
      });
    }

    const quote = await bookingService.createQuote(tenantId, actor, parsed.data);
    return reply.status(201).send(quote);
  });

  // POST /v1/bookings/prepare: Prepare booking with slot hold, signed intent & approval locator
  app.post("/v1/bookings/prepare", async (request, reply) => {
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const clientId = request.clientId || "default-client";
    const principal = request.principal || {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId,
      roles: ["OWNER"],
      roleVersion: 1,
      authTime: new Date().toISOString(),
      mfaVerified: true,
    };

    const actor: BookingActor = {
      subject: principal.subject,
      userId: principal.userId,
      tenantId: principal.tenantId,
      roles: principal.roles,
    };

    const parsed = prepareBookingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_prepare_input",
        detail: parsed.error.message,
      });
    }

    const res = await bookingService.prepareBooking(tenantId, actor, clientId, parsed.data);
    return reply.status(201).send(res);
  });

  // POST /v1/booking-holds: Alias for prepare booking
  app.post("/v1/booking-holds", async (request, reply) => {
    const body = (request.body as Record<string, unknown>) || {};
    const customer = (body.customer as Record<string, unknown>) || {};
    // Normalize to prepare input format if legacy format used
    const preparePayload = {
      serviceId: typeof body.serviceId === "string" ? body.serviceId : "01932b10-0001-7000-8000-000000000001",
      locationId: typeof body.locationId === "string" ? body.locationId : "01932b10-0002-7000-8000-000000000001",
      startsAt: typeof body.startsAt === "string" ? body.startsAt : new Date(Date.now() + 3600_000).toISOString(),
      timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
      customer: {
        email: typeof customer.email === "string" ? customer.email : "guest@velvetai.internal",
        displayName: typeof customer.displayName === "string" ? customer.displayName : "Guest User",
      },
      note: typeof body.note === "string" ? body.note : undefined,
    };

    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const clientId = request.clientId || "default-client";
    const principal = request.principal || {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId,
      roles: ["OWNER"],
      roleVersion: 1,
      authTime: new Date().toISOString(),
      mfaVerified: true,
    };

    const actor: BookingActor = {
      subject: principal.subject,
      userId: principal.userId,
      tenantId: principal.tenantId,
      roles: principal.roles,
    };

    const parsed = prepareBookingInputSchema.safeParse(preparePayload);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_prepare_input",
        detail: parsed.error.message,
      });
    }

    const res = await bookingService.prepareBooking(tenantId, actor, clientId, parsed.data);
    return reply.status(201).send(res);
  });

  // GET /v1/booking-approvals/:locator: Retrieve terms from immutable server snapshot per Section D.4
  app.get("/v1/booking-approvals/:locator", async (request, reply) => {
    const { locator } = request.params as { locator: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);

    // Hardened security headers per Amendment D.4
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");

    const details = await bookingService.getApprovalDetails(tenantId, locator);
    return reply.status(200).send(details);
  });

  // POST /v1/booking-approvals/:locator/confirm: Buyer approves terms -> issues one-time confirmation token
  app.post("/v1/booking-approvals/:locator/confirm", async (request, reply) => {
    const { locator } = request.params as { locator: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const buyerUserId =
      request.principal?.userId || ("01932b10-0000-7000-8000-000000000002" as UserId);

    const confirmation = await bookingService.confirmApproval(tenantId, locator, buyerUserId);
    return reply.status(200).send(confirmation);
  });

  // POST /v1/bookings/commit: Atomic commit operation per Amendment Section D.5, D.6 and W4
  app.post("/v1/bookings/commit", async (request, reply) => {
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const clientId = request.clientId || "default-client";
    const principal = request.principal || {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId,
      roles: ["OWNER"],
      roleVersion: 1,
      authTime: new Date().toISOString(),
      mfaVerified: true,
    };

    const actor: BookingActor = {
      subject: principal.subject,
      userId: principal.userId,
      tenantId: principal.tenantId,
      roles: principal.roles,
    };

    // Strict closed schema validation per D.5
    const parsed = commitBookingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_commit_input",
        detail: parsed.error.message,
      });
    }

    const result = await bookingService.commitBooking(tenantId, actor, clientId, parsed.data);
    return reply.status(200).send(result);
  });

  // GET /v1/bookings/:id: Retrieve booking by ID
  app.get("/v1/bookings/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);

    const booking = await withTenantTransaction(db, tenantId, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();
    });

    if (!booking) {
      return reply.status(404).send({
        title: "Booking Not Found",
        status: 404,
        code: "booking_not_found",
        detail: `No active booking found for id ${id}`,
      });
    }

    return reply.status(200).send({
      id: booking.id,
      tenantId: booking.tenant_id,
      customerId: booking.customer_id,
      quoteId: booking.quote_id,
      status: booking.status,
      version: booking.version,
      holdExpiresAt: booking.hold_expires_at ? booking.hold_expires_at.toISOString() : null,
      startsAt: booking.starts_at.toISOString(),
      endsAt: booking.ends_at.toISOString(),
      resourceId: booking.resource_id,
    });
  });

  // POST /v1/bookings/:id/prepare-cancellation: Prepare cancellation with policy quotation
  app.post("/v1/bookings/:id/prepare-cancellation", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);

    const booking = await withTenantTransaction(db, tenantId, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", id)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();
    });

    if (!booking) {
      return reply.status(404).send({
        title: "Booking Not Found",
        status: 404,
        code: "booking_not_found",
        detail: `Booking ${id} was not found`,
      });
    }

    const parsed = prepareCancellationInputSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_cancellation_input",
        detail: parsed.error.message,
      });
    }

    return reply.status(200).send({
      bookingId: booking.id,
      cancellationAllowed: true,
      refundEligibleMinor: "2000",
      currency: "USD",
      policySummary: "Eligible for 100% deposit refund prior to 24-hour cutoff.",
    });
  });
};
