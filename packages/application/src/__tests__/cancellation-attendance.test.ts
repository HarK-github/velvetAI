import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import { createDatabaseClient, migrateToLatest, Database } from "@velvetai/db";
import { BookingService, BookingActor } from "../booking-service.js";
import { PaymentService } from "../payment-service.js";
import {
  PaymentPort,
  CreateOrderParams,
  CreateOrderResult,
  CapturePaymentParams,
  CapturePaymentResult,
  RefundPaymentParams,
  RefundPaymentResult,
  CreateInvoiceDraftParams,
  CreateInvoiceDraftResult,
  SendInvoiceResult,
  VerifyWebhookParams,
} from "../ports.js";
import {
  TenantId,
  UserId,
  ServiceId,
  LocationId,
  ResourceId,
  BookingId,
  BookingQuoteId,
  PaymentCaptureId,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  refundIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
  PayPalOrderDetails,
  PayPalCaptureDetails,
  PayPalRefundDetails,
} from "@velvetai/contracts";

class MockPaymentPort implements PaymentPort {
  orderCreationFailure?: Error;
  captureOutcome: "CAPTURED" | "UNCERTAIN" | "FAILED" = "CAPTURED";
  captureError?: Error;
  refundOutcome: "COMPLETED" | "FAILED" | "UNCERTAIN" = "COMPLETED";
  refundError?: Error;
  webhookValid: boolean = true;

  ordersCreated: CreateOrderParams[] = [];
  capturesExecuted: CapturePaymentParams[] = [];
  refundsExecuted: RefundPaymentParams[] = [];
  invoicesCreated: CreateInvoiceDraftParams[] = [];

  async createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
    this.ordersCreated.push(params);
    if (this.orderCreationFailure) {
      throw this.orderCreationFailure;
    }
    return {
      providerOrderId: `ORDER_${crypto.randomUUID().slice(0, 8)}`,
      paymentIntentId: paymentIntentIdSchema.parse(crypto.randomUUID()),
    };
  }

  async getOrder(providerOrderId: string): Promise<PayPalOrderDetails> {
    return {
      id: providerOrderId,
      status: "COMPLETED",
      intent: "CAPTURE",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      captures: [
        {
          id: `CAP_${providerOrderId}`,
          status: "COMPLETED",
          amount: {
            currency: currencyCodeSchema.parse("USD"),
            valueMinor: moneyMinorSchema.parse("5000"),
          },
        },
      ],
    };
  }

  async capturePayment(params: CapturePaymentParams): Promise<CapturePaymentResult> {
    this.capturesExecuted.push(params);
    if (this.captureError) {
      throw this.captureError;
    }
    return {
      providerCaptureId: `CAP_${crypto.randomUUID().slice(0, 8)}`,
      paymentCaptureId: paymentCaptureIdSchema.parse(crypto.randomUUID()),
      status: this.captureOutcome,
    };
  }

  async getCapture(providerCaptureId: string): Promise<PayPalCaptureDetails> {
    return {
      id: providerCaptureId,
      status: "COMPLETED",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
    };
  }

  async refundPayment(params: RefundPaymentParams): Promise<RefundPaymentResult> {
    this.refundsExecuted.push(params);
    if (this.refundError) {
      throw this.refundError;
    }
    return {
      refundId: refundIdSchema.parse(crypto.randomUUID()),
      providerRefundId: `REF_${crypto.randomUUID().slice(0, 8)}`,
      status: this.refundOutcome === "UNCERTAIN" ? "REQUESTED" : this.refundOutcome,
    };
  }

  async getRefund(providerRefundId: string): Promise<PayPalRefundDetails> {
    return {
      id: providerRefundId,
      status: "COMPLETED",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("2500"),
      },
    };
  }

  async verifyWebhookSignature(_params: VerifyWebhookParams): Promise<boolean> {
    return this.webhookValid;
  }

  async createInvoiceDraft(params: CreateInvoiceDraftParams): Promise<CreateInvoiceDraftResult> {
    this.invoicesCreated.push(params);
    return {
      providerInvoiceId: `INV_${crypto.randomUUID().slice(0, 8)}`,
      providerInvoiceNumber: "INV-0001",
    };
  }

  async sendInvoice(providerInvoiceId: string): Promise<SendInvoiceResult> {
    return {
      providerInvoiceId,
      status: "SENT",
    };
  }
}

const TEST_DB_URL =
  process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";

describe("W4: Cancellation and Attendance Minimum Lifecycle", () => {
  let db: Kysely<Database>;
  let bookingService: BookingService;
  let paymentService: PaymentService;
  let mockPort: MockPaymentPort;

  let tenantId: TenantId;
  let customerActor: BookingActor;
  let merchantActor: BookingActor;
  let nonMerchantActor: BookingActor;
  let locationId: LocationId;
  let resourceId: ResourceId;
  let serviceId: ServiceId;
  let serviceVersionId: string;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    mockPort = new MockPaymentPort();
    paymentService = new PaymentService(db, mockPort);
    bookingService = new BookingService(db, paymentService);

    tenantId = crypto.randomUUID() as TenantId;
    const customerId = crypto.randomUUID() as UserId;
    const merchantId = crypto.randomUUID() as UserId;
    const unauthorizedId = crypto.randomUUID() as UserId;

    customerActor = {
      subject: "buyer|123",
      userId: customerId,
      tenantId,
      roles: ["CUSTOMER"],
    };

    merchantActor = {
      subject: "merchant|owner",
      userId: merchantId,
      tenantId,
      roles: ["OWNER", "MANAGER"],
    };

    nonMerchantActor = {
      subject: "guest|999",
      userId: unauthorizedId,
      tenantId,
      roles: ["CUSTOMER"],
    };

    locationId = crypto.randomUUID() as LocationId;
    resourceId = crypto.randomUUID() as ResourceId;
    serviceId = crypto.randomUUID() as ServiceId;
    serviceVersionId = crypto.randomUUID();

    // 1. Seed tenant & base entities
    await db
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: "W4 Test Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .execute();

    await db
      .insertInto("locations")
      .values({
        id: locationId,
        tenant_id: tenantId,
        name: "Main Salon",
        timezone: "America/New_York",
        status: "ACTIVE",
      })
      .execute();

    await db
      .insertInto("resources")
      .values({
        id: resourceId,
        tenant_id: tenantId,
        location_id: locationId,
        resource_type: "STAFF",
        display_name: "Stylist 1",
        status: "ACTIVE",
      })
      .execute();

    // Circular FK resolution for service & service_version
    await db
      .insertInto("services")
      .values({
        id: serviceId,
        tenant_id: tenantId,
        status: "ACTIVE",
        current_version_id: null,
      })
      .execute();

    await db
      .insertInto("service_versions")
      .values({
        id: serviceVersionId,
        tenant_id: tenantId,
        service_id: serviceId,
        version: 1,
        name: "Haircut & Color",
        duration_minutes: 60,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        price_minor: "10000",
        base_deposit_minor: "2500",
        currency: "USD",
        cancellation_policy_id: crypto.randomUUID(),
      })
      .execute();

    await db
      .updateTable("services")
      .set({ current_version_id: serviceVersionId })
      .where("id", "=", serviceId)
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  // Helper to create a test booking in any desired status and appointment time
  async function seedTestBooking(params: {
    status: string;
    startsAt: Date;
    endsAt: Date;
    captureState?: "COMPLETED" | "CAPTURE_UNCERTAIN" | "NO_CAPTURE";
    resourceId?: ResourceId;
  }): Promise<{ bookingId: BookingId; quoteId: BookingQuoteId; resourceId: ResourceId }> {
    const bookingId = crypto.randomUUID() as BookingId;
    const quoteId = crypto.randomUUID() as BookingQuoteId;
    const claimId = crypto.randomUUID();

    let resId = params.resourceId;
    if (!resId) {
      resId = crypto.randomUUID() as ResourceId;
      await db
        .insertInto("resources")
        .values({
          id: resId,
          tenant_id: tenantId,
          location_id: locationId,
          resource_type: "STAFF",
          display_name: "Stylist " + resId.slice(0, 4),
          status: "ACTIVE",
        })
        .execute();
    }

    await db
      .insertInto("booking_quotes")
      .values({
        id: quoteId,
        tenant_id: tenantId,
        service_version_id: serviceVersionId,
        customer_id: customerActor.userId,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        total_minor: "10000",
        deposit_minor: "2500",
        currency: "USD",
        canonical_hash: "a".repeat(64),
        expires_at: new Date(Date.now() + 60_000),
      })
      .execute();

    await db
      .insertInto("bookings")
      .values({
        id: bookingId,
        tenant_id: tenantId,
        customer_id: customerActor.userId,
        quote_id: quoteId,
        status: params.status,
        version: 1,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        resource_id: resId,
      })
      .execute();

    // Insert booking hold snapshot for balance invoice testing
    await db
      .insertInto("booking_hold_snapshots")
      .values({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        booking_id: bookingId,
        service_version_id: serviceVersionId,
        resource_id: resId,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        total_minor: "10000",
        deposit_minor: "2500",
        currency: "USD",
        currency_scale: 2,
        cancellation_policy_id: crypto.randomUUID(),
        cancellation_policy_version: 1,
        cancellation_policy_hash: "b".repeat(64),
        merchant_id: merchantActor.userId,
        client_id: "test-client",
        actor_id: customerActor.userId,
        canonical_hash: "c".repeat(64),
      })
      .execute();

    const isBlocking = ["HELD", "COMMITTING", "CAPTURE_UNCERTAIN", "CONFIRMED"].includes(
      params.status,
    );
    await db
      .insertInto("resource_claims")
      .values({
        id: claimId,
        tenant_id: tenantId,
        booking_id: bookingId,
        resource_id: resId,
        blocked_during: sql`tstzrange(${params.startsAt.toISOString()}::timestamptz, ${params.endsAt.toISOString()}::timestamptz, '[)')`,
        starts_at: params.startsAt,
        ends_at: params.endsAt,
        state: isBlocking ? "CONFIRMED" : "RELEASED",
        blocking: isBlocking,
      })
      .execute();

    if (params.captureState && params.captureState !== "NO_CAPTURE") {
      const intentId = crypto.randomUUID();
      await db
        .insertInto("payment_intents")
        .values({
          id: intentId,
          tenant_id: tenantId,
          booking_id: bookingId,
          provider_order_id: "ORD-" + crypto.randomUUID().slice(0, 8),
          amount_minor: "2500",
          currency: "USD",
          state: params.captureState === "CAPTURE_UNCERTAIN" ? "CAPTURE_UNCERTAIN" : "CAPTURED",
          payment_expires_at: new Date(Date.now() + 3600_000),
          request_id: "req-" + crypto.randomUUID(),
        })
        .execute();

      const captureId = crypto.randomUUID() as PaymentCaptureId;
      await db
        .insertInto("payment_captures")
        .values({
          id: captureId,
          tenant_id: tenantId,
          payment_intent_id: intentId,
          booking_id: bookingId,
          provider_capture_id: "CAP-" + crypto.randomUUID().slice(0, 8),
          amount_minor: "2500",
          currency: "USD",
          state: params.captureState === "CAPTURE_UNCERTAIN" ? "PENDING" : params.captureState,
        })
        .execute();
    }

    return { bookingId, quoteId, resourceId: resId };
  }

  it("1. Cancellation before 24h cutoff: eligible for 100% deposit refund", async () => {
    // 48 hours in future (> 24h cutoff)
    const startsAt = new Date(Date.now() + 48 * 3600_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const { bookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt,
      endsAt,
      captureState: "COMPLETED",
    });

    const prep = await bookingService.prepareCancellation(tenantId, customerActor, bookingId);
    expect(prep.cancellationAllowed).toBe(true);
    expect(prep.refundEligibleMinor).toBe("2500");
    expect(prep.cutoffPassed).toBe(false);
    expect(prep.cancellationConfirmationToken).toBeDefined();

    const commit = await bookingService.commitCancellation(tenantId, customerActor, bookingId, {
      cancellationConfirmationToken: prep.cancellationConfirmationToken!,
      reason: "Scheduling conflict",
    });

    expect(commit.status).toBe("CANCELLED");
    expect(commit.refundStatus).toBe("COMPLETED");
    expect(commit.refundAmountMinor).toBe("2500");
    expect(commit.resourceClaimReleased).toBe(true);

    // Verify claim is unblocked in DB
    const claim = await db
      .selectFrom("resource_claims")
      .where("booking_id", "=", bookingId)
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    expect(claim?.blocking).toBe(false);
    expect(claim?.state).toBe("RELEASED");

    // Verify outbox event written
    const outbox = await db
      .selectFrom("outbox_events")
      .where("aggregate_id", "=", bookingId)
      .where("event_type", "=", "booking.cancelled")
      .selectAll()
      .executeTakeFirst();
    expect(outbox).toBeDefined();
  });

  it("2. Cancellation after 24h cutoff: late cancellation with 0 deposit refund", async () => {
    // 4 hours in future (< 24h cutoff)
    const startsAt = new Date(Date.now() + 4 * 3600_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const { bookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt,
      endsAt,
      captureState: "COMPLETED",
    });

    const prep = await bookingService.prepareCancellation(tenantId, customerActor, bookingId);
    expect(prep.cancellationAllowed).toBe(true);
    expect(prep.refundEligibleMinor).toBe("0");
    expect(prep.cutoffPassed).toBe(true);
    expect(prep.cancellationConfirmationToken).toBeDefined();

    const commit = await bookingService.commitCancellation(tenantId, customerActor, bookingId, {
      cancellationConfirmationToken: prep.cancellationConfirmationToken!,
      reason: "Emergency late cancel",
    });

    expect(commit.status).toBe("CANCELLED");
    expect(commit.refundStatus).toBe("NO_REFUND");
    expect(commit.refundAmountMinor).toBe("0");
    expect(commit.resourceClaimReleased).toBe(true);
  });

  it("3. Cancellation during CAPTURE_UNCERTAIN: transitions to CANCEL_REQUESTED and keeps resource claim blocking", async () => {
    const startsAt = new Date(Date.now() + 36 * 3600_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const { bookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt,
      endsAt,
      captureState: "CAPTURE_UNCERTAIN",
    });

    const prep = await bookingService.prepareCancellation(tenantId, customerActor, bookingId);
    const commit = await bookingService.commitCancellation(tenantId, customerActor, bookingId, {
      cancellationConfirmationToken: prep.cancellationConfirmationToken!,
      reason: "Cancel during uncertain capture",
    });

    expect(commit.status).toBe("CANCEL_REQUESTED");
    expect(commit.refundStatus).toBe("UNCERTAIN");
    expect(commit.resourceClaimReleased).toBe(false);

    // Verify claim in DB is STILL blocking
    const claim = await db
      .selectFrom("resource_claims")
      .where("booking_id", "=", bookingId)
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    expect(claim?.blocking).toBe(true);

    // Verify booking in DB is in CANCEL_REQUESTED
    const booking = await db
      .selectFrom("bookings")
      .where("id", "=", bookingId)
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    expect(booking?.status).toBe("CANCEL_REQUESTED");
  });

  it("4. Idempotent re-execution of cancellation commit", async () => {
    const startsAt = new Date(Date.now() + 48 * 3600_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const { bookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt,
      endsAt,
      captureState: "COMPLETED",
    });

    const prep = await bookingService.prepareCancellation(tenantId, customerActor, bookingId);
    const firstCommit = await bookingService.commitCancellation(
      tenantId,
      customerActor,
      bookingId,
      {
        cancellationConfirmationToken: prep.cancellationConfirmationToken!,
      },
    );
    expect(firstCommit.status).toBe("CANCELLED");

    // Second commit with same token returns idempotent cancelled result
    const secondCommit = await bookingService.commitCancellation(
      tenantId,
      customerActor,
      bookingId,
      {
        cancellationConfirmationToken: prep.cancellationConfirmationToken!,
      },
    );
    expect(secondCommit.status).toBe("CANCELLED");
    expect(secondCommit.bookingId).toBe(bookingId);
  });

  it("5. Check-in policy: rejected > 2h before start, allowed <= 2h before start", async () => {
    // 5 hours in future (> 2h check-in window)
    const startsAtEarly = new Date(Date.now() + 5 * 3600_000);
    const endsAtEarly = new Date(startsAtEarly.getTime() + 3600_000);
    const { bookingId: earlyBookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt: startsAtEarly,
      endsAt: endsAtEarly,
    });

    // Check-in too early must fail
    await expect(
      bookingService.checkInBooking(tenantId, merchantActor, earlyBookingId),
    ).rejects.toThrow(/within 2 hours/);

    // 1 hour in future (<= 2h check-in window)
    const startsAtValid = new Date(Date.now() + 1 * 3600_000);
    const endsAtValid = new Date(startsAtValid.getTime() + 3600_000);
    const { bookingId: validBookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt: startsAtValid,
      endsAt: endsAtValid,
    });

    const checkIn = await bookingService.checkInBooking(tenantId, merchantActor, validBookingId);
    expect(checkIn.status).toBe("CHECKED_IN");
    expect(checkIn.previousStatus).toBe("CONFIRMED");

    // Non-merchant role is rejected
    await expect(
      bookingService.checkInBooking(tenantId, nonMerchantActor, validBookingId),
    ).rejects.toThrow(/role required/);
  });

  it("6. No-show policy: rejected before 15m grace period, allowed after grace period", async () => {
    // Appointment started 5 minutes ago (< 15m grace period)
    const startsAtRecent = new Date(Date.now() - 5 * 60_000);
    const endsAtRecent = new Date(startsAtRecent.getTime() + 3600_000);
    const { bookingId: recentBookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt: startsAtRecent,
      endsAt: endsAtRecent,
    });

    await expect(
      bookingService.noShowBooking(tenantId, merchantActor, recentBookingId),
    ).rejects.toThrow(/grace period/);

    // Appointment started 20 minutes ago (> 15m grace period)
    const startsAtPastGrace = new Date(Date.now() - 20 * 60_000);
    const endsAtPastGrace = new Date(startsAtPastGrace.getTime() + 3600_000);
    const { bookingId: pastBookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt: startsAtPastGrace,
      endsAt: endsAtPastGrace,
    });

    const noShow = await bookingService.noShowBooking(tenantId, merchantActor, pastBookingId);
    expect(noShow.status).toBe("NO_SHOW");

    // Resource claim is released on no-show
    const claim = await db
      .selectFrom("resource_claims")
      .where("booking_id", "=", pastBookingId)
      .where("tenant_id", "=", tenantId)
      .selectAll()
      .executeTakeFirst();
    expect(claim?.blocking).toBe(false);
  });

  it("7. Completed appointment allows balance invoice creation; unfulfilled rejected", async () => {
    const startsAt = new Date(Date.now() - 3600_000);
    const endsAt = new Date();
    const { bookingId } = await seedTestBooking({
      status: "CONFIRMED",
      startsAt,
      endsAt,
      captureState: "COMPLETED",
    });

    // Unfulfilled (CONFIRMED) booking rejects balance invoice creation
    await expect(
      paymentService.createBalanceInvoice({
        tenantId,
        bookingId,
        customerEmail: "buyer@example.com",
      }),
    ).rejects.toThrow(/requires appointment status COMPLETED/);

    // Merchant marks booking COMPLETED
    const completion = await bookingService.completeBooking(tenantId, merchantActor, bookingId);
    expect(completion.status).toBe("COMPLETED");

    // Completed booking permits balance invoice creation
    const invoiceResult = await paymentService.createBalanceInvoice({
      tenantId,
      bookingId,
      customerEmail: "buyer@example.com",
      customerName: "Jane Doe",
    });

    expect(invoiceResult.invoiceId).toBeDefined();
    expect(invoiceResult.balanceDue.valueMinor).toBe("7500"); // 10000 total - 2500 deposit
    expect(invoiceResult.balanceDue.currency).toBe("USD");
  });
});
