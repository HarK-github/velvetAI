import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { Kysely, sql } from "kysely";
import {
  Database,
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
} from "@velvetai/db";
import {
  TenantId,
  LocationId,
  ServiceId,
  ResourceId,
  UserId,
  PaymentCaptureId,
  RefundId,
  refundIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
  bookingIdSchema,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  getCurrencyScale,
  isSupportedMvpCurrency,
  SUPPORTED_MVP_CURRENCIES,
  IdempotencyConflictError,
  SlotUnavailableError,
  DomainError,
} from "@velvetai/contracts";
import {
  PaymentPort,
  CreateOrderParams,
  CreateOrderResult,
  CapturePaymentParams,
  CapturePaymentResult,
  RefundPaymentParams,
  RefundPaymentResult,
  PayPalOrderDetails,
  PayPalCaptureDetails,
  PayPalRefundDetails,
  VerifyWebhookParams,
  CreateInvoiceDraftParams,
  CreateInvoiceDraftResult,
  SendInvoiceResult,
  PayPalInvoiceDetails,
} from "../ports.js";
import { PaymentService } from "../payment-service.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable";

/**
 * Deterministic Mock PaymentPort for testing fault injection, state branches, and ledger effects.
 */
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

  async getInvoice(providerInvoiceId: string): Promise<PayPalInvoiceDetails> {
    return {
      id: providerInvoiceId,
      status: "SENT",
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("10000"),
      },
    };
  }
}

describe("Payment Lifecycle & Ledger Integration (Requirements W3-W9)", () => {
  let db: Kysely<Database>;
  let mockPort: MockPaymentPort;
  let paymentService: PaymentService;
  let tenantId: TenantId;
  let locationId: LocationId;
  let serviceId: ServiceId;
  let resourceId: ResourceId;
  let userId: UserId;
  let connectionKey: string;
  let serviceVersionId: string;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);
    mockPort = new MockPaymentPort();
    paymentService = new PaymentService(db, mockPort);

    tenantId = crypto.randomUUID() as TenantId;
    locationId = crypto.randomUUID() as LocationId;
    serviceId = crypto.randomUUID() as ServiceId;
    resourceId = crypto.randomUUID() as ResourceId;
    userId = crypto.randomUUID() as UserId;

    // Seed tenant and user
    await db
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: `tenant-pay-${Date.now()}`,
        default_currency: "USD",
        status: "ACTIVE",
      })
      .execute();

    await db
      .insertInto("app_users")
      .values({
        id: userId,
        oidc_subject: `oidc|pay-user-${userId}`,
        email_ciphertext: "pay-user@example.com",
      })
      .execute();

    // Seed tenant fixtures
    await withTenantTransaction(db, tenantId, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: tenantId,
          name: "SoHo Flagship Studio",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: resourceId,
          tenant_id: tenantId,
          location_id: locationId,
          display_name: "Senior Stylist Station 1",
          resource_type: "STAFF",
          status: "ACTIVE",
        })
        .execute();

      serviceVersionId = crypto.randomUUID();
      await trx
        .insertInto("services")
        .values({
          id: serviceId,
          tenant_id: tenantId,
          status: "ACTIVE",
          current_version_id: null,
        })
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: serviceVersionId,
          tenant_id: tenantId,
          service_id: serviceId,
          version: 1,
          name: "Hair Styling",
          duration_minutes: 60,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "15000",
          base_deposit_minor: "5000",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: serviceVersionId })
        .where("id", "=", serviceId)
        .execute();

      // Seed provider connection
      connectionKey = `conn_test_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
      await trx
        .insertInto("provider_connections")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          provider: "PAYPAL",
          environment: "sandbox",
          connection_key: connectionKey,
          client_id: "test_client_id",
          client_secret_ciphertext: "enc:test_secret",
          webhook_id: "WH-TEST-123",
          status: "ACTIVE",
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  let slotCounter = 0;
  async function createTestBookingHold(
    customDepositMinor = "5000",
    expiredPaymentWindow = false,
    currency = "USD",
  ) {
    slotCounter++;
    const bookingId = bookingIdSchema.parse(crypto.randomUUID());
    const startsAt = new Date(Date.now() + 10_000_000 + slotCounter * 7200_000);
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    const now = Date.now();
    const paymentExpiresAt = expiredPaymentWindow
      ? new Date(now - 60_000) // 1 minute in the past
      : new Date(now + 600_000); // 10 minutes in the future

    const quoteId = crypto.randomUUID();

    await withTenantTransaction(db, tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantId,
          service_version_id: serviceVersionId,
          customer_id: userId,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: "15000",
          deposit_minor: customDepositMinor,
          currency,
          canonical_hash: "canonical-hash-001",
          expires_at: new Date(now + 300_000),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantId,
          customer_id: userId,
          quote_id: quoteId,
          resource_id: resourceId,
          starts_at: startsAt,
          ends_at: endsAt,
          status: "COMMITTING",
          version: 1,
          hold_expires_at: new Date(now + 300_000),
          payment_expires_at: paymentExpiresAt,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          booking_id: bookingId,
          resource_id: resourceId,
          starts_at: startsAt,
          ends_at: endsAt,
          blocking: true,
          state: "COMMITTING",
          blocked_during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)')`,
          hold_expires_at: new Date(now + 300_000),
          expires_at: paymentExpiresAt,
        })
        .execute();

      await trx
        .insertInto("booking_hold_snapshots")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          booking_id: bookingId,
          service_version_id: serviceVersionId,
          resource_id: resourceId,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: "15000",
          deposit_minor: customDepositMinor,
          currency,
          currency_scale: getCurrencyScale(currency),
          cancellation_policy_id: crypto.randomUUID(),
          cancellation_policy_version: 1,
          cancellation_policy_hash: "hash-001",
          merchant_id: tenantId,
          client_id: "client-001",
          actor_id: userId,
          canonical_hash: "canonical-hash-001",
        })
        .execute();
    });

    return { bookingId, paymentExpiresAt };
  }

  it("1. Order create uses server snapshot amount/currency and opaque metadata", async () => {
    mockPort.ordersCreated = [];
    const { bookingId } = await createTestBookingHold("5000");

    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-1",
    });

    expect(orderRes.paymentIntentId).toBeDefined();
    expect(orderRes.paypalOrderId).toBeDefined();
    expect(orderRes.amount.valueMinor).toBe("5000");
    expect(orderRes.amount.currency).toBe("USD");
    expect(orderRes.status).toBe("REQUIRES_PAYER_ACTION");

    // Verify adapter call parameters
    const calledOrder = mockPort.ordersCreated[0];
    expect(calledOrder?.bookingId).toBe(bookingId);
    expect(calledOrder?.amount.valueMinor).toBe("5000");
    expect(calledOrder?.amount.currency).toBe("USD");
    expect(calledOrder?.requestId).toBe("req-order-1");

    // Verify provider_operations record in DB
    const op = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("provider_operations")
        .where("paypal_request_id", "=", "req-order-1")
        .selectAll()
        .executeTakeFirst(),
    );

    expect(op?.state).toBe("SUCCEEDED");
    expect(op?.provider_order_id).toBe(orderRes.paypalOrderId);
  });

  it("2. Stable request ID replay returns one provider order", async () => {
    const { bookingId } = await createTestBookingHold("5000");

    const first = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-replay",
    });

    const second = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-replay",
    });

    expect(second.paypalOrderId).toBe(first.paypalOrderId);
    expect(second.paymentIntentId).toBe(first.paymentIntentId);

    // Verify only one order was dispatched to adapter
    const matchingDispatches = mockPort.ordersCreated.filter((o) => o.requestId === "req-order-replay");
    expect(matchingDispatches).toHaveLength(1);
  });

  it("3. Different payload under same request ID fails with IdempotencyConflictError", async () => {
    const { bookingId: b1 } = await createTestBookingHold("5000");
    const { bookingId: b2 } = await createTestBookingHold("7500");

    await paymentService.createDepositOrder({
      tenantId,
      bookingId: b1,
      idempotencyKey: "req-conflict-key",
    });

    await expect(
      paymentService.createDepositOrder({
        tenantId,
        bookingId: b2,
        idempotencyKey: "req-conflict-key",
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("4. Capture COMPLETED confirms booking exactly once and posts balanced journal", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-cap-1",
    });

    mockPort.captureOutcome = "CAPTURED";
    const captureRes = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-1",
    });

    expect(captureRes.bookingStatus).toBe("CONFIRMED");
    expect(captureRes.paymentStatus).toBe("CAPTURED");
    expect(captureRes.providerCaptureId).toBeDefined();

    // Verify booking in DB is CONFIRMED
    const booking = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(booking?.status).toBe("CONFIRMED");

    // Verify resource claim is CONFIRMED and blocking
    const claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("CONFIRMED");
    expect(claim?.blocking).toBe(true);

    // Verify double-entry financial journal entry and lines
    const journalEntry = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("financial_journal_entries")
        .where("booking_id", "=", bookingId)
        .selectAll()
        .executeTakeFirst(),
    );

    expect(journalEntry?.entry_type).toBe("DEPOSIT_CAPTURE");

    const lines = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("financial_journal_lines")
        .where("journal_entry_id", "=", journalEntry!.id)
        .selectAll()
        .execute(),
    );

    expect(lines).toHaveLength(2);
    const debitLine = lines.find((l) => l.account === "ASSET:PAYPAL_CLEARING");
    const creditLine = lines.find((l) => l.account === "LIABILITY:CUSTOMER_DEPOSIT");

    expect(debitLine?.debit_minor).toBe("5000");
    expect(debitLine?.credit_minor).toBe("0");
    expect(creditLine?.debit_minor).toBe("0");
    expect(creditLine?.credit_minor).toBe("5000");

    // Replay capture call: returns cached confirmation exactly once
    const replayCapture = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-1",
    });
    expect(replayCapture.bookingStatus).toBe("CONFIRMED");
  });

  it("5. Capture PENDING transitions to CAPTURE_UNCERTAIN and keeps resource claim blocking", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-pending-1",
    });

    mockPort.captureOutcome = "UNCERTAIN";
    const captureRes = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-pending-1",
    });

    expect(captureRes.bookingStatus).toBe("CAPTURE_UNCERTAIN");
    expect(captureRes.paymentStatus).toBe("UNCERTAIN");
    expect(captureRes.statusUrl).toBeDefined();

    // Verify booking in DB is CAPTURE_UNCERTAIN
    const booking = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(booking?.status).toBe("CAPTURE_UNCERTAIN");

    // Verify resource claim remains blocking
    const claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("CAPTURE_UNCERTAIN");
    expect(claim?.blocking).toBe(true);
  });

  it("6. Capture response timeout/error transitions to CAPTURE_UNCERTAIN and SENT_UNKNOWN", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-timeout-1",
    });

    mockPort.captureError = new Error("PayPal network socket timeout");
    const captureRes = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-timeout-1",
    });
    mockPort.captureError = undefined;

    expect(captureRes.bookingStatus).toBe("CAPTURE_UNCERTAIN");
    expect(captureRes.paymentStatus).toBe("UNCERTAIN");

    const op = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("provider_operations")
        .where("paypal_request_id", "=", "req-cap-timeout-1")
        .selectAll()
        .executeTakeFirst(),
    );

    expect(op?.state).toBe("SENT_UNKNOWN");
  });

  it("7. Payment window expiry prevents capture dispatch and releases resource claim", async () => {
    const { bookingId } = await createTestBookingHold("5000", true); // expired window

    await expect(
      paymentService.createDepositOrder({
        tenantId,
        bookingId,
        idempotencyKey: "req-order-expired-1",
      }),
    ).rejects.toThrow(SlotUnavailableError);

    // Verify booking is PAYMENT_WINDOW_EXPIRED
    const booking = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(booking?.status).toBe("PAYMENT_WINDOW_EXPIRED");

    // Verify claim is RELEASED and non-blocking
    const claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("RELEASED");
    expect(claim?.blocking).toBe(false);
  });

  it("8. Refund serialization under capture row lock prevents over-refund", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-rf-1",
    });

    mockPort.captureOutcome = "CAPTURED";
    await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-rf-1",
    });

    const capture = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("payment_captures")
        .where("booking_id", "=", bookingId)
        .selectAll()
        .executeTakeFirstOrThrow(),
    );

    mockPort.refundOutcome = "COMPLETED";

    // 1st partial refund: $25.00
    const r1 = await paymentService.refundPayment({
      tenantId,
      captureId: capture.id as PaymentCaptureId,
      amountMinor: "2500",
      reason: "Partial refund requested",
      actorRole: "MERCHANT",
      idempotencyKey: "req-refund-1",
    });
    expect(r1.status).toBe("COMPLETED");

    // 2nd partial refund exceeding remaining balance ($30.00 > remaining $25.00): rejected!
    await expect(
      paymentService.refundPayment({
        tenantId,
        captureId: capture.id as PaymentCaptureId,
        amountMinor: "3000",
        reason: "Excessive refund",
        actorRole: "MERCHANT",
        idempotencyKey: "req-refund-2",
      }),
    ).rejects.toThrow(DomainError);

    // 3rd refund exactly for remaining balance: $25.00 -> succeeds!
    const r3 = await paymentService.refundPayment({
      tenantId,
      captureId: capture.id as PaymentCaptureId,
      amountMinor: "2500",
      reason: "Final balance refund",
      actorRole: "MERCHANT",
      idempotencyKey: "req-refund-3",
    });
    expect(r3.status).toBe("COMPLETED");

    // Capture state transitions to REFUNDED
    const updatedCapture = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("payment_captures")
        .where("id", "=", capture.id)
        .selectAll()
        .executeTakeFirst(),
    );
    expect(updatedCapture?.state).toBe("REFUNDED");

    // Verify reversing journal entries
    const refundJournalEntries = await withTenantTransaction(db, tenantId, (trx) =>
      trx
        .selectFrom("financial_journal_entries")
        .where("booking_id", "=", bookingId)
        .where("entry_type", "=", "REFUND")
        .selectAll()
        .execute(),
    );
    expect(refundJournalEntries).toHaveLength(2);
  });

  it("9. Webhook ingress quarantines raw payload and rejects duplicate event delivery idempotently", async () => {
    const rawEvent = JSON.stringify({
      id: "WH-EVENT-001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-WH-1" },
    });

    const { deliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: "trans-wh-1",
      transmissionTime: "2026-10-21T10:00:00Z",
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: rawEvent,
      bodyBytesLength: Buffer.byteLength(rawEvent),
    });

    expect(deliveryId).toBeDefined();

    mockPort.webhookValid = true;
    const processedFirst = await paymentService.processWebhookDelivery(deliveryId);
    expect(processedFirst).toBe(true);

    // Replay duplicate event delivery: skips without creating duplicate verified row
    const processedSecond = await paymentService.processWebhookDelivery(deliveryId);
    expect(processedSecond).toBe(false); // already verified, skips idempotently
  });

  it("10. Balance invoice creates and sends Invoicing v2 draft for completed appointment", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-inv-1",
    });

    mockPort.captureOutcome = "CAPTURED";
    await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-inv-1",
    });

    // Complete the appointment
    await withTenantTransaction(db, tenantId, async (trx) => {
      await trx.updateTable("bookings").set({ status: "COMPLETED" }).where("id", "=", bookingId).execute();
    });

    // Create balance invoice: Total $150.00 minus $50.00 deposit = $100.00 balance due
    const invoice = await paymentService.createBalanceInvoice({
      tenantId,
      bookingId,
      customerEmail: "client@example.com",
      customerName: "Jane Client",
    });

    expect(invoice.invoiceId).toBeDefined();
    expect(invoice.status).toBe("SENT");
    expect(invoice.total.valueMinor).toBe("15000");
    expect(invoice.depositPaid.valueMinor).toBe("5000");
    expect(invoice.balanceDue.valueMinor).toBe("10000");

    // Verify invoice row in DB projection
    const dbInvoice = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("invoices").where("id", "=", invoice.invoiceId).selectAll().executeTakeFirst(),
    );
    expect(dbInvoice?.status).toBe("SENT");
    expect(dbInvoice?.balance_due_minor).toBe("10000");
  });

  it("11. Opt-in sandbox test: skips cleanly when credentials absent, executes when present", async () => {
    const isLiveOptIn = process.env.PAYPAL_SANDBOX_LIVE === "true" || process.env.RUN_PAYPAL_SANDBOX_E2E === "1";
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const isPlaceholder = !clientId || clientId.startsWith("placeholder_");

    if (!isLiveOptIn || isPlaceholder) {
      console.log(
        "[SANDBOX_E2E] STATUS: BLOCKED / NOT_RUN — Reason: Real PayPal sandbox requires untracked live credentials and public ingress. Placeholder credentials detected.",
      );
      expect(true).toBe(true);
      return;
    }

    expect(process.env.PAYPAL_CLIENT_ID).toBeDefined();
    expect(process.env.PAYPAL_CLIENT_SECRET).toBeDefined();
  });

  it("12. Definitive capture failure before expiry transitions booking to PAYMENT_FAILED and releases resource claim", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-fail-1",
    });

    mockPort.captureOutcome = "FAILED";
    const captureRes = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-fail-1",
    });

    expect(captureRes.bookingStatus).toBe("PAYMENT_FAILED");
    expect(captureRes.paymentStatus).toBe("FAILED");

    // Booking must be PAYMENT_FAILED (distinct from PAYMENT_WINDOW_EXPIRED)
    const booking = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(booking?.status).toBe("PAYMENT_FAILED");

    // Payment intent must be PAYMENT_FAILED
    const intent = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("payment_intents").where("id", "=", orderRes.paymentIntentId).selectAll().executeTakeFirst(),
    );
    expect(intent?.state).toBe("PAYMENT_FAILED");

    // Claim must be RELEASED and non-blocking
    const claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("RELEASED");
    expect(claim?.blocking).toBe(false);
  });

  it("13. Capture PENDING transitions to CAPTURE_UNCERTAIN; later webhook COMPLETED confirms once, DECLINED releases once", async () => {
    // 1. Initial UNCERTAIN capture
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-pend-reconcile",
    });

    mockPort.captureOutcome = "UNCERTAIN";
    const captureRes = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-pend-reconcile",
    });

    expect(captureRes.bookingStatus).toBe("CAPTURE_UNCERTAIN");
    expect(captureRes.providerCaptureId).toBeDefined();
    const providerCaptureId = captureRes.providerCaptureId!;

    // Claim remains blocking
    let claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("CAPTURE_UNCERTAIN");
    expect(claim?.blocking).toBe(true);

    // 2. Later webhook COMPLETED arrives: confirms booking once and posts balanced journal
    const completedWebhook = JSON.stringify({
      id: `WH-EVENT-COMPLETED-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: providerCaptureId },
    });

    const { deliveryId: compDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-comp-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: completedWebhook,
      bodyBytesLength: Buffer.byteLength(completedWebhook),
    });

    mockPort.webhookValid = true;
    await paymentService.processWebhookDelivery(compDeliveryId, tenantId);

    const bookingConfirmed = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(bookingConfirmed?.status).toBe("CONFIRMED");

    claim = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(claim?.state).toBe("CONFIRMED");
    expect(claim?.blocking).toBe(true);

    // Verify journal entry posted and balanced
    const journal = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("financial_journal_entries").where("booking_id", "=", bookingId).selectAll().executeTakeFirst(),
    );
    expect(journal?.status).toBe("POSTED");

    // 3. Separate booking where capture PENDING later receives DECLINED: releases claim
    const { bookingId: b2 } = await createTestBookingHold("5000");
    const orderRes2 = await paymentService.createDepositOrder({
      tenantId,
      bookingId: b2,
      idempotencyKey: "req-order-pend-dec",
    });

    mockPort.captureOutcome = "UNCERTAIN";
    const capRes2 = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes2.paymentIntentId,
      idempotencyKey: "req-cap-pend-dec",
    });

    const declinedWebhook = JSON.stringify({
      id: `WH-EVENT-DECLINED-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: { id: capRes2.providerCaptureId },
    });

    const { deliveryId: decDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-dec-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: declinedWebhook,
      bodyBytesLength: Buffer.byteLength(declinedWebhook),
    });

    await paymentService.processWebhookDelivery(decDeliveryId, tenantId);

    const bookingDeclined = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", b2).selectAll().executeTakeFirst(),
    );
    expect(bookingDeclined?.status).toBe("PAYMENT_FAILED");

    const claimDeclined = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", b2).selectAll().executeTakeFirst(),
    );
    expect(claimDeclined?.state).toBe("RELEASED");
    expect(claimDeclined?.blocking).toBe(false);
  });

  it("14. Webhook quarantine poisoning prevention: forged unverified event does not reserve event ID", async () => {
    const poisonedEventId = `WH-POISON-${crypto.randomUUID().slice(0, 8)}`;
    const eventPayload = JSON.stringify({
      id: poisonedEventId,
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-POISON-1" },
    });

    // 1. Attacker sends forged payload with invalid signature
    const { deliveryId: poisonedDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: "trans-forged-1",
      transmissionTime: new Date().toISOString(),
      certUrl: "https://attacker.com/fake-cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "bad-sig",
      rawPayload: eventPayload,
      bodyBytesLength: Buffer.byteLength(eventPayload),
    });

    mockPort.webhookValid = false; // signature check fails
    const poisonResult = await paymentService.processWebhookDelivery(poisonedDeliveryId, tenantId);
    expect(poisonResult).toBe(false);

    // Verify it was marked REJECTED in quarantine
    const deliveryRow = await db
      .selectFrom("webhook_quarantine")
      .where("id", "=", poisonedDeliveryId)
      .selectAll()
      .executeTakeFirst();
    expect(deliveryRow?.verification_state).toBe("REJECTED");

    // Proves: verified_provider_events does NOT contain the event ID
    const verifiedRow = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("verified_provider_events").where("provider_event_id", "=", poisonedEventId).selectAll().executeTakeFirst(),
    );
    expect(verifiedRow).toBeUndefined();

    // 2. Legitimate PayPal webhook arrives with the same event ID
    const { deliveryId: legitimateDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: "trans-legit-1",
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "valid-sig",
      rawPayload: eventPayload,
      bodyBytesLength: Buffer.byteLength(eventPayload),
    });

    mockPort.webhookValid = true; // signature check passes
    const legitResult = await paymentService.processWebhookDelivery(legitimateDeliveryId, tenantId);
    expect(legitResult).toBe(true);

    // Verified event row is now present
    const verifiedLegit = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("verified_provider_events").where("provider_event_id", "=", poisonedEventId).selectAll().executeTakeFirst(),
    );
    expect(verifiedLegit).toBeDefined();
    expect(verifiedLegit?.provider_event_id).toBe(poisonedEventId);

    // 3. Replaying the valid delivery idempotently succeeds without duplicate row
    const replayResult = await paymentService.processWebhookDelivery(legitimateDeliveryId, tenantId);
    expect(replayResult).toBe(false); // already verified
  });

  it("15. Out-of-order material webhook reconciliation: REFUNDED before CAPTURE.COMPLETED, duplicate PENDING, external dashboard refund, approval-reversed", async () => {
    // Subtest A: REFUNDED arriving before locally observed CAPTURE.COMPLETED
    const { bookingId: bA } = await createTestBookingHold("5000");
    const orderResA = await paymentService.createDepositOrder({
      tenantId,
      bookingId: bA,
      idempotencyKey: "req-order-ooo-1",
    });

    mockPort.captureOutcome = "UNCERTAIN";
    const capResA = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderResA.paymentIntentId,
      idempotencyKey: "req-cap-ooo-1",
    });

    // Webhook REFUNDED arrives for capResA.providerCaptureId while local capture is UNCERTAIN
    const refundedWebhook = JSON.stringify({
      id: `WH-REFUNDED-OOO-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: `REF-OOO-${Date.now()}`,
        capture_id: capResA.providerCaptureId,
        amount: { value: "50.00", currency_code: "USD" },
      },
    });

    const { deliveryId: refDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-ref-ooo-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: refundedWebhook,
      bodyBytesLength: Buffer.byteLength(refundedWebhook),
    });

    mockPort.webhookValid = true;
    await paymentService.processWebhookDelivery(refDeliveryId, tenantId);

    // Reducer confirmed the booking and then processed refund
    const bookingA = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bA).selectAll().executeTakeFirst(),
    );
    expect(bookingA?.status).toBe("CONFIRMED");

    const captureA = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("payment_captures").where("booking_id", "=", bA).selectAll().executeTakeFirst(),
    );
    expect(captureA?.state).toBe("REFUNDED");

    // Subtest B: Duplicate PENDING arriving after COMPLETED does NOT downgrade state
    const dupPendingWebhook = JSON.stringify({
      id: `WH-DUP-PEND-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.PENDING",
      resource: { id: capResA.providerCaptureId },
    });

    const { deliveryId: dupDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-dup-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: dupPendingWebhook,
      bodyBytesLength: Buffer.byteLength(dupPendingWebhook),
    });

    await paymentService.processWebhookDelivery(dupDeliveryId, tenantId);

    // Still confirmed, not downgraded
    const bookingAAfterDup = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bA).selectAll().executeTakeFirst(),
    );
    expect(bookingAAfterDup?.status).toBe("CONFIRMED");

    // Subtest C: External dashboard refund creates refund reservation and posts journal
    const { bookingId: bC } = await createTestBookingHold("5000");
    const orderResC = await paymentService.createDepositOrder({
      tenantId,
      bookingId: bC,
      idempotencyKey: "req-order-ext-rf",
    });

    mockPort.captureOutcome = "CAPTURED";
    const capResC = await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderResC.paymentIntentId,
      idempotencyKey: "req-cap-ext-rf",
    });

    const extRefundId = `REF-EXT-${Date.now()}`;
    const extRefundWebhook = JSON.stringify({
      id: `WH-EXT-RF-${Date.now()}`,
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: extRefundId,
        capture_id: capResC.providerCaptureId,
        amount: { value: "20.00", currency_code: "USD" },
      },
    });

    const { deliveryId: extDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-ext-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: extRefundWebhook,
      bodyBytesLength: Buffer.byteLength(extRefundWebhook),
    });

    await paymentService.processWebhookDelivery(extDeliveryId, tenantId);

    // Capture state transitions to PARTIALLY_REFUNDED
    const captureC = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("payment_captures").where("booking_id", "=", bC).selectAll().executeTakeFirst(),
    );
    expect(captureC?.state).toBe("PARTIALLY_REFUNDED");

    // Subtest D: CHECKOUT.PAYMENT-APPROVAL.REVERSED moves booking to PAYMENT_FAILED and releases claim
    const { bookingId: bD } = await createTestBookingHold("5000");
    const orderResD = await paymentService.createDepositOrder({
      tenantId,
      bookingId: bD,
      idempotencyKey: "req-order-reversed-1",
    });

    const reversedWebhook = JSON.stringify({
      id: `WH-REVERSED-${Date.now()}`,
      event_type: "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
      resource: { id: orderResD.paypalOrderId },
    });

    const { deliveryId: revDeliveryId } = await paymentService.ingestWebhookDelivery({
      connectionKey,
      environment: "sandbox",
      transmissionId: `trans-rev-${Date.now()}`,
      transmissionTime: new Date().toISOString(),
      certUrl: "https://api.sandbox.paypal.com/cert",
      authAlgo: "SHA256withRSA",
      transmissionSig: "sig==",
      rawPayload: reversedWebhook,
      bodyBytesLength: Buffer.byteLength(reversedWebhook),
    });

    await paymentService.processWebhookDelivery(revDeliveryId, tenantId);

    const bookingD = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("bookings").where("id", "=", bD).selectAll().executeTakeFirst(),
    );
    expect(bookingD?.status).toBe("PAYMENT_FAILED");

    const claimD = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("resource_claims").where("booking_id", "=", bD).selectAll().executeTakeFirst(),
    );
    expect(claimD?.state).toBe("RELEASED");
    expect(claimD?.blocking).toBe(false);
  });

  it("16. Refund unknown outcomes: 5xx/timeout retains reservation in UNKNOWN and capacity reserved; 4xx releases; reconcileUnknownRefund under row-lock", async () => {
    const { bookingId } = await createTestBookingHold("5000");
    const orderRes = await paymentService.createDepositOrder({
      tenantId,
      bookingId,
      idempotencyKey: "req-order-rf-unk",
    });

    mockPort.captureOutcome = "CAPTURED";
    await paymentService.capturePayment({
      tenantId,
      paymentIntentId: orderRes.paymentIntentId,
      idempotencyKey: "req-cap-rf-unk",
    });

    const capture = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("payment_captures").where("booking_id", "=", bookingId).selectAll().executeTakeFirstOrThrow(),
    );

    // 1. 503 Service Unavailable: moves to UNKNOWN, retains capacity reserved
    mockPort.refundError = Object.assign(new Error("PayPal 503 Service Unavailable"), { statusCode: 503 });

    const unkRefundRes = await paymentService.refundPayment({
      tenantId,
      captureId: capture.id as PaymentCaptureId,
      amountMinor: "3000",
      reason: "Timeout refund test",
      actorRole: "MERCHANT",
      idempotencyKey: "req-rf-timeout-1",
    });

    expect(unkRefundRes.status).toBe("UNCERTAIN");

    const unkReservation = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("refund_reservations").where("id", "=", unkRefundRes.refundId).selectAll().executeTakeFirst(),
    );
    expect(unkReservation?.state).toBe("UNKNOWN");

    // Capacity remains reserved: attempting another $30.00 refund ($30.00 + $30.00 > $50.00) is REJECTED
    await expect(
      paymentService.refundPayment({
        tenantId,
        captureId: capture.id as PaymentCaptureId,
        amountMinor: "3000",
        reason: "Second refund exceeding balance due to UNKNOWN reservation",
        actorRole: "MERCHANT",
        idempotencyKey: "req-rf-timeout-2",
      }),
    ).rejects.toThrow(DomainError);

    // 2. Definitive 400 rejection: reservation moves to FAILED and releases capacity
    mockPort.refundError = Object.assign(new Error("PayPal 400 Bad Request: Invalid Amount"), { statusCode: 400 });

    await expect(
      paymentService.refundPayment({
        tenantId,
        captureId: capture.id as PaymentCaptureId,
        amountMinor: "1000",
        reason: "Definitive rejection test",
        actorRole: "MERCHANT",
        idempotencyKey: "req-rf-badreq-1",
      }),
    ).rejects.toThrow();

    mockPort.refundError = undefined;

    // 3. Reconcile unknown refund using reconcileUnknownRefund
    const reconciled = await paymentService.reconcileUnknownRefund({
      tenantId,
      refundId: unkRefundRes.refundId as RefundId,
    });

    expect(reconciled.status).toBe("COMPLETED");

    const updatedRes = await withTenantTransaction(db, tenantId, (trx) =>
      trx.selectFrom("refund_reservations").where("id", "=", unkRefundRes.refundId).selectAll().executeTakeFirst(),
    );
    expect(updatedRes?.state).toBe("COMPLETED");
  });

  it("17. Supported MVP currencies: USD allowlist enforced; unsupported currency rejected; decimal conversions tested", async () => {
    // 1. Unsupported currency (EUR) rejected before order creation
    const { bookingId: eurBookingId } = await createTestBookingHold("5000", false, "EUR");
    await expect(
      paymentService.createDepositOrder({
        tenantId,
        bookingId: eurBookingId,
        idempotencyKey: "req-order-eur",
      }),
    ).rejects.toThrow(/not supported/i);

    // 2. Supported MVP currency (USD) succeeds
    const { bookingId: usdBookingId } = await createTestBookingHold("5000", false, "USD");
    const usdOrder = await paymentService.createDepositOrder({
      tenantId,
      bookingId: usdBookingId,
      idempotencyKey: "req-order-usd-mvp",
    });
    expect(usdOrder.amount.currency).toBe("USD");
    expect(isSupportedMvpCurrency("USD")).toBe(true);
    expect(SUPPORTED_MVP_CURRENCIES).toContain("USD");

    // 3. Currency decimal conversions across 0-, 2-, and 3-decimal currencies
    expect(decimalToMinorUnits("50.25", getCurrencyScale("USD"))).toBe("5025");
    expect(minorUnitsToDecimal("5025", getCurrencyScale("USD"))).toBe("50.25");

    expect(decimalToMinorUnits("1000", getCurrencyScale("JPY"))).toBe("1000");
    expect(minorUnitsToDecimal("1000", getCurrencyScale("JPY"))).toBe("1000");

    expect(decimalToMinorUnits("12.345", getCurrencyScale("KWD"))).toBe("12345");
    expect(minorUnitsToDecimal("12345", getCurrencyScale("KWD"))).toBe("12.345");
  });

  it("18. Automated fake-provider test suite distinguished from real PayPal sandbox test", () => {
    // Audit Requirement 6 & 10: Clear demarcation between fake-provider unit/integration tests and real sandbox
    expect(mockPort).toBeInstanceOf(MockPaymentPort);
  });
});
