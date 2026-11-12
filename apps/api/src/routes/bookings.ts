import { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { BookingService, BookingActor } from "@velvetai/application";
import { createDatabaseClient, withTenantTransaction } from "@velvetai/db";
import {
  createBookingQuoteInputSchema,
  prepareBookingInputSchema,
  commitBookingInputSchema,
  prepareCancellationInputSchema,
  commitCancellationInputSchema,
  BookingId,
  TenantId,
  UserId,
} from "@velvetai/contracts";
import { paymentService } from "./payments.js";

// Shared database client instance for API booking routes
const databaseUrl =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";
const db = createDatabaseClient(databaseUrl);
let bookingService = new BookingService(db, paymentService);

export function setBookingService(service: BookingService) {
  bookingService = service;
}

export { bookingService };

export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  const defaultFallbackTenantId = (process.env.PUBLIC_DEMO_TENANT_ID ||
    process.env.SELF_SIGNUP_TENANT_ID ||
    "01932b10-0000-7000-8000-000000000a01") as TenantId;

  async function resolveServiceTenant(
    dbClient: typeof db,
    preferredTenantId: TenantId,
    serviceId: string,
  ): Promise<TenantId> {
    const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
      return await trx
        .selectFrom("services")
        .where("id", "=", serviceId)
        .where("tenant_id", "=", preferredTenantId)
        .where("status", "=", "ACTIVE")
        .select(["tenant_id"])
        .executeTakeFirst();
    });
    if (inPreferred) return inPreferred.tenant_id as TenantId;

    const candidates = await dbClient
      .selectFrom("tenants")
      .where("status", "=", "ACTIVE")
      .where("id", "!=", preferredTenantId)
      .select(["id"])
      .execute();

    for (const candidate of candidates) {
      const candidateTenantId = candidate.id as TenantId;
      const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
        return await trx
          .selectFrom("services")
          .where("id", "=", serviceId)
          .where("tenant_id", "=", candidateTenantId)
          .where("status", "=", "ACTIVE")
          .select(["tenant_id"])
          .executeTakeFirst();
      });
      if (found) return found.tenant_id as TenantId;
    }
    return preferredTenantId;
  }

  async function resolveQuote(
    dbClient: typeof db,
    preferredTenantId: TenantId,
    quoteId: string,
  ): Promise<{ tenantId: TenantId; serviceId: string; startsAt: Date } | undefined> {
    const inPreferred = await withTenantTransaction(dbClient, preferredTenantId, async (trx) => {
      return await trx
        .selectFrom("booking_quotes")
        .innerJoin("service_versions", "service_versions.id", "booking_quotes.service_version_id")
        .where("booking_quotes.id", "=", quoteId)
        .where("booking_quotes.tenant_id", "=", preferredTenantId)
        .select([
          "booking_quotes.tenant_id",
          "service_versions.service_id",
          "booking_quotes.starts_at",
        ])
        .executeTakeFirst();
    });
    if (inPreferred) {
      return {
        tenantId: inPreferred.tenant_id as TenantId,
        serviceId: inPreferred.service_id,
        startsAt: inPreferred.starts_at,
      };
    }

    const candidates = await dbClient
      .selectFrom("tenants")
      .where("status", "=", "ACTIVE")
      .where("id", "!=", preferredTenantId)
      .select(["id"])
      .execute();

    for (const candidate of candidates) {
      const candidateTenantId = candidate.id as TenantId;
      const found = await withTenantTransaction(dbClient, candidateTenantId, async (trx) => {
        return await trx
          .selectFrom("booking_quotes")
          .innerJoin("service_versions", "service_versions.id", "booking_quotes.service_version_id")
          .where("booking_quotes.id", "=", quoteId)
          .where("booking_quotes.tenant_id", "=", candidateTenantId)
          .select([
            "booking_quotes.tenant_id",
            "service_versions.service_id",
            "booking_quotes.starts_at",
          ])
          .executeTakeFirst();
      });
      if (found) {
        return {
          tenantId: found.tenant_id as TenantId,
          serviceId: found.service_id,
          startsAt: found.starts_at,
        };
      }
    }
    return undefined;
  }

  async function resolveActiveLocation(
    dbClient: typeof db,
    tenantId: TenantId,
    requestedLocationId?: string,
  ): Promise<string | undefined> {
    return await withTenantTransaction(dbClient, tenantId, async (trx) => {
      if (requestedLocationId) {
        const match = await trx
          .selectFrom("locations")
          .where("id", "=", requestedLocationId)
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "ACTIVE")
          .select(["id"])
          .executeTakeFirst();
        if (match) return match.id;
      }
      const fallbackLoc = await trx
        .selectFrom("locations")
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "ACTIVE")
        .select(["id"])
        .executeTakeFirst();
      return fallbackLoc?.id;
    });
  }

  // POST /v1/booking-quotes: Request a 5-minute versioned booking quote
  app.post("/v1/booking-quotes", async (request, reply) => {
    const initialTenantId = request.tenantId || defaultFallbackTenantId;
    const parsed = createBookingQuoteInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_quote_input",
        detail: parsed.error.message,
      });
    }

    const tenantId = await resolveServiceTenant(db, initialTenantId, parsed.data.serviceId);
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
      tenantId,
      roles: principal.roles,
    };

    const quote = await bookingService.createQuote(tenantId, actor, parsed.data);
    return reply.status(201).send(quote);
  });

  // POST /v1/bookings/prepare: Prepare booking with slot hold, signed intent & approval locator
  app.post("/v1/bookings/prepare", async (request, reply) => {
    const initialTenantId = request.tenantId || defaultFallbackTenantId;
    const clientId = request.clientId || "default-client";
    const parsed = prepareBookingInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_prepare_input",
        detail: parsed.error.message,
      });
    }

    const tenantId = await resolveServiceTenant(db, initialTenantId, parsed.data.serviceId);
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
      tenantId,
      roles: principal.roles,
    };

    const res = await bookingService.prepareBooking(tenantId, actor, clientId, parsed.data);
    return reply.status(201).send(res);
  });

  // POST /v1/booking-holds: Alias for prepare booking
  app.post("/v1/booking-holds", async (request, reply) => {
    const body = (request.body as Record<string, unknown>) || {};
    const customer = (body.customer as Record<string, unknown>) || {};
    const initialTenantId = request.tenantId || defaultFallbackTenantId;

    let resolvedQuote: { tenantId: TenantId; serviceId: string; startsAt: Date } | undefined;
    if (typeof body.quoteId === "string" && body.quoteId.trim().length > 0) {
      resolvedQuote = await resolveQuote(db, initialTenantId, body.quoteId.trim());
    }

    const effectiveServiceId =
      (typeof body.serviceId === "string" && body.serviceId.trim().length > 0
        ? body.serviceId.trim()
        : resolvedQuote?.serviceId) || "01932b10-0001-7000-8000-000000000001";

    const tenantId = await resolveServiceTenant(
      db,
      resolvedQuote?.tenantId || initialTenantId,
      effectiveServiceId,
    );

    const activeLocationId = await resolveActiveLocation(
      db,
      tenantId,
      typeof body.locationId === "string" ? body.locationId : undefined,
    );

    const startsAt =
      typeof body.startsAt === "string" && body.startsAt.trim().length > 0
        ? body.startsAt.trim()
        : resolvedQuote?.startsAt
          ? resolvedQuote.startsAt.toISOString()
          : new Date(Date.now() + 3600_000).toISOString();

    const preparePayload = {
      serviceId: effectiveServiceId,
      locationId:
        activeLocationId ||
        (typeof body.locationId === "string"
          ? body.locationId
          : "01932b10-0002-7000-8000-000000000001"),
      startsAt,
      timeZone: typeof body.timeZone === "string" ? body.timeZone : "UTC",
      customer: {
        email: typeof customer.email === "string" ? customer.email : "guest@velvetai.internal",
        displayName: typeof customer.displayName === "string" ? customer.displayName : "Guest User",
      },
      note: typeof body.note === "string" ? body.note : undefined,
    };

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
      tenantId,
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
    const tenantId = request.tenantId || defaultFallbackTenantId;

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
    const tenantId = request.tenantId || defaultFallbackTenantId;

    // Human Buyer Authorization Guard (Invariant F1):
    // 1. Unauthenticated requests are rejected with 401 HUMAN_APPROVAL_REQUIRED
    if (!request.headers.authorization) {
      return reply.status(401).send({
        title: "Unauthorized",
        status: 401,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail:
          "Authentication credentials missing. Human buyer session required to approve booking.",
      });
    }

    const principal = request.principal;
    if (!principal) {
      return reply.status(401).send({
        title: "Unauthorized",
        status: 401,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Authentication credentials missing or invalid. Human buyer session required.",
      });
    }

    // 2. Agents / M2M clients (subject ending in "@clients") cannot approve booking holds
    if (principal.subject.endsWith("@clients")) {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail:
          "Agents and machine-to-machine clients cannot approve booking holds. Human buyer approval is required.",
      });
    }

    // 3. Dev tokens are forbidden outside test environment
    if (principal.subject.startsWith("dev|") && process.env.NODE_ENV !== "test") {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Dev tokens are not permitted for booking approvals outside test environment.",
      });
    }

    // 4. Must possess BUYER or OWNER role
    if (!principal.roles.includes("BUYER") && !principal.roles.includes("OWNER")) {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Buyer membership required to approve booking holds.",
      });
    }

    const confirmation = await bookingService.confirmApproval(tenantId, locator, principal.userId, {
      actorSubject: principal.subject,
    });
    return reply.status(200).send(confirmation);
  });

  // POST /v1/booking-approvals/:locator/approve-and-commit: Atomically approve and commit hold per D1
  app.post("/v1/booking-approvals/:locator/approve-and-commit", async (request, reply) => {
    const { locator } = request.params as { locator: string };
    const tenantId = request.tenantId || defaultFallbackTenantId;
    const clientId = request.clientId || "default-client";
    const idempotencyKey = request.headers["idempotency-key"] as string;

    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "idempotency_key_required",
        requestId: request.id,
        detail: "Missing required Idempotency-Key header",
      });
    }

    // Human Buyer Authorization Guard (Invariant F1 / D1):
    // 1. Unauthenticated requests are rejected with 401 HUMAN_APPROVAL_REQUIRED
    if (!request.headers.authorization) {
      return reply.status(401).send({
        title: "Unauthorized",
        status: 401,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail:
          "Authentication credentials missing. Human buyer session required to approve booking.",
      });
    }

    const principal = request.principal;
    if (!principal) {
      return reply.status(401).send({
        title: "Unauthorized",
        status: 401,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Authentication credentials missing or invalid. Human buyer session required.",
      });
    }

    // 2. Agents / M2M clients (subject ending in "@clients") cannot approve booking holds
    if (principal.subject.endsWith("@clients")) {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail:
          "Agents and machine-to-machine clients cannot approve booking holds. Human buyer approval is required.",
      });
    }

    // 3. Dev tokens are forbidden outside test environment
    if (principal.subject.startsWith("dev|") && process.env.NODE_ENV !== "test") {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Dev tokens are not permitted for booking approvals outside test environment.",
      });
    }

    // 4. Must possess BUYER or OWNER role
    if (!principal.roles.includes("BUYER") && !principal.roles.includes("OWNER")) {
      return reply.status(403).send({
        title: "Forbidden",
        status: 403,
        code: "HUMAN_APPROVAL_REQUIRED",
        requestId: request.id,
        detail: "Buyer membership required to approve booking holds.",
      });
    }

    const actor: BookingActor = {
      userId: principal.userId,
      subject: principal.subject,
      tenantId: principal.tenantId,
      roles: principal.roles,
    };

    const res = await bookingService.approveAndCommit(
      tenantId,
      locator,
      principal.userId,
      actor,
      clientId,
      idempotencyKey,
    );

    return reply.status(200).send(res);
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

    const rawBody =
      typeof request.body === "object" && request.body !== null
        ? { ...(request.body as Record<string, unknown>) }
        : {};
    if (!rawBody.idempotency_key && request.headers["idempotency-key"]) {
      rawBody.idempotency_key = request.headers["idempotency-key"];
    }

    // Strict closed schema validation per D.5
    const parsed = commitBookingInputSchema.safeParse(rawBody);
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

  const getBookingActor = (request: FastifyRequest, tenantId: TenantId): BookingActor => {
    const principal = request.principal || {
      subject: "dev|default-owner",
      userId: "01932b10-0000-7000-8000-000000000002" as UserId,
      tenantId,
      roles: ["OWNER"],
    };
    return {
      subject: principal.subject,
      userId: principal.userId,
      tenantId: principal.tenantId || tenantId,
      roles: principal.roles || ["OWNER"],
    };
  };

  // POST /v1/bookings/:id/prepare-cancellation & POST /v1/bookings/:id/cancel/prepare
  const handlePrepareCancellation = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const actor = getBookingActor(request, tenantId);

    const parsed = prepareCancellationInputSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_cancellation_input",
        detail: parsed.error.message,
      });
    }

    const result = await bookingService.prepareCancellation(
      tenantId,
      actor,
      id as BookingId,
      parsed.data,
    );
    return reply.status(200).send(result);
  };

  app.post("/v1/bookings/:id/prepare-cancellation", handlePrepareCancellation);
  app.post("/v1/bookings/:id/cancel/prepare", handlePrepareCancellation);

  // POST /v1/bookings/:id/cancel: Commit cancellation with signed confirmation token
  app.post("/v1/bookings/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const actor = getBookingActor(request, tenantId);

    const parsed = commitCancellationInputSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        title: "Bad Request",
        status: 400,
        code: "invalid_cancellation_input",
        detail: parsed.error.message,
      });
    }

    const result = await bookingService.commitCancellation(
      tenantId,
      actor,
      id as BookingId,
      parsed.data,
    );
    return reply.status(result.status === "CANCEL_REQUESTED" ? 202 : 200).send(result);
  });

  // POST /v1/bookings/:id/check-in: Merchant attendance check-in
  app.post("/v1/bookings/:id/check-in", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const actor = getBookingActor(request, tenantId);

    const result = await bookingService.checkInBooking(tenantId, actor, id as BookingId);
    return reply.status(200).send(result);
  });

  // POST /v1/bookings/:id/complete: Merchant attendance complete
  app.post("/v1/bookings/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const actor = getBookingActor(request, tenantId);

    const result = await bookingService.completeBooking(tenantId, actor, id as BookingId);
    return reply.status(200).send(result);
  });

  // POST /v1/bookings/:id/no-show: Merchant attendance no-show
  app.post("/v1/bookings/:id/no-show", async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.tenantId || ("01932b10-0000-7000-8000-000000000001" as TenantId);
    const actor = getBookingActor(request, tenantId);

    const result = await bookingService.noShowBooking(tenantId, actor, id as BookingId);
    return reply.status(200).send(result);
  });
};
