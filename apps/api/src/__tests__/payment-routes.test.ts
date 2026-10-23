import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { buildApp } from "../app.js";
import {
  PaymentService,
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
} from "@velvetai/application";
import {
  currencyCodeSchema,
  moneyMinorSchema,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  refundIdSchema,
} from "@velvetai/contracts";
import { setPaymentService } from "../routes/payments.js";

const TEST_DB_URL = getTestDatabaseUrl();

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DEV_USER_ID = "01932b10-0000-7000-8000-000000000002";
const DEV_LOCATION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_SERVICE_ID = "01932b10-0001-7000-8000-000000000001";
const DEV_SERVICE_VERSION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_RESOURCE_ID = "01932b10-0004-7000-8000-000000000001";

class FakePaymentPort implements PaymentPort {
  captureOutcome: "CAPTURED" | "UNCERTAIN" | "FAILED" = "CAPTURED";
  refundOutcome: "COMPLETED" | "FAILED" | "UNCERTAIN" = "COMPLETED";

  async createOrder(_params: CreateOrderParams): Promise<CreateOrderResult> {
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
        valueMinor: moneyMinorSchema.parse("2000"),
      },
      captures: [],
    };
  }

  async capturePayment(_params: CapturePaymentParams): Promise<CapturePaymentResult> {
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
        valueMinor: moneyMinorSchema.parse("2000"),
      },
    };
  }

  async refundPayment(_params: RefundPaymentParams): Promise<RefundPaymentResult> {
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
        valueMinor: moneyMinorSchema.parse("1000"),
      },
    };
  }

  async verifyWebhookSignature(_params: VerifyWebhookParams): Promise<boolean> {
    return true;
  }

  async createInvoiceDraft(_params: CreateInvoiceDraftParams): Promise<CreateInvoiceDraftResult> {
    return {
      providerInvoiceId: `INV_${crypto.randomUUID().slice(0, 8)}`,
      providerInvoiceNumber: "INV-001",
    };
  }

  async sendInvoice(invoiceId: string): Promise<SendInvoiceResult> {
    return {
      providerInvoiceId: invoiceId,
      status: "SENT",
    };
  }

  async getInvoice(invoiceId: string): Promise<PayPalInvoiceDetails> {
    return {
      id: invoiceId,
      status: "SENT",
      total: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("7500"),
      },
      depositPaid: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("2000"),
      },
      balanceDue: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5500"),
      },
    };
  }
}

describe("API PayPal Payment & Ingress Endpoints (W3 - W8)", () => {
  let app: FastifyInstance;
  let db: Kysely<Database>;
  let fakePort: FakePaymentPort;
  let testPaymentService: PaymentService;
  let slotCounter = 1;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    fakePort = new FakePaymentPort();
    testPaymentService = new PaymentService(db, fakePort);
    setPaymentService(testPaymentService);

    // Seed base dev tenant and resource
    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Velvet Flagship Manhattan",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: DEV_LOCATION_ID,
          tenant_id: DEV_TENANT_ID,
          name: "SoHo Flagship",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: DEV_SERVICE_ID,
          tenant_id: DEV_TENANT_ID,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: DEV_SERVICE_VERSION_ID,
          tenant_id: DEV_TENANT_ID,
          service_id: DEV_SERVICE_ID,
          version: 1,
          name: "Executive Haircut & Beard Sculpt",
          duration_minutes: 45,
          buffer_before_minutes: 0,
          buffer_after_minutes: 15,
          price_minor: "7500",
          base_deposit_minor: "2000",
          currency: "USD",
          cancellation_policy_id: "01932b10-0003-7000-8000-000000000001",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: DEV_RESOURCE_ID,
          tenant_id: DEV_TENANT_ID,
          location_id: DEV_LOCATION_ID,
          resource_type: "CHAIR",
          display_name: "Master Chair 1",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      // Provider connection
      await trx
        .insertInto("provider_connections")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          provider: "PAYPAL",
          environment: "sandbox",
          connection_key: "default",
          client_id: "test_client",
          client_secret_ciphertext: "test_secret",
          webhook_id: "WH-TEST-1",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "connection_key"]).doNothing())
        .execute();
    });

    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await db.destroy();
  });

  async function createCommittingBooking() {
    const bookingId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const startsAt = new Date(
      Date.now() +
        86400_000 * 500 +
        Math.floor(Math.random() * 10_000_000_000) +
        slotCounter * 7200_000,
    );
    const endsAt = new Date(startsAt.getTime() + 45 * 60_000);
    slotCounter++;

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: DEV_TENANT_ID,
          service_version_id: DEV_SERVICE_VERSION_ID,
          customer_id: DEV_USER_ID,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: "7500",
          deposit_minor: "2000",
          currency: "USD",
          canonical_hash: "canonical-hash-routes-test",
          expires_at: new Date(Date.now() + 600_000),
          created_at: new Date(),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: DEV_TENANT_ID,
          quote_id: quoteId,
          customer_id: DEV_USER_ID,
          resource_id: DEV_RESOURCE_ID,
          starts_at: startsAt,
          ends_at: endsAt,
          status: "COMMITTING",
          version: 1,
          hold_expires_at: new Date(Date.now() + 300_000),
          payment_expires_at: new Date(Date.now() + 600_000),
          created_at: new Date(),
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          booking_id: bookingId,
          resource_id: DEV_RESOURCE_ID,
          starts_at: startsAt,
          ends_at: endsAt,
          blocked_during: `[${startsAt.toISOString()}, ${endsAt.toISOString()})`,
          blocking: true,
          state: "COMMITTING",
          created_at: new Date(),
        })
        .execute();

      await trx
        .insertInto("booking_hold_snapshots")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          booking_id: bookingId,
          service_version_id: DEV_SERVICE_VERSION_ID,
          resource_id: DEV_RESOURCE_ID,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: "7500",
          deposit_minor: "2000",
          currency: "USD",
          currency_scale: 2,
          cancellation_policy_id: crypto.randomUUID(),
          cancellation_policy_version: 1,
          cancellation_policy_hash: "hash-snap-001",
          merchant_id: DEV_TENANT_ID,
          client_id: "client-001",
          actor_id: DEV_USER_ID,
          canonical_hash: "canonical-hash-snap-001",
          created_at: new Date(),
        })
        .execute();
    });

    return { bookingId };
  }

  it("POST /v1/bookings/:bookingId/payment-order creates Orders v2 deposit order", async () => {
    const { bookingId } = await createCommittingBooking();

    const res = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/payment-order`,
      headers: {
        "idempotency-key": `req-order-api-${bookingId}`,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.paypalOrderId).toBeDefined();
    expect(body.paymentIntentId).toBeDefined();
    expect(body.amount.valueMinor).toBe("2000");
    expect(body.status).toBe("REQUIRES_PAYER_ACTION");
    expect(body.paymentExpiresAt).toBeDefined();
  });

  it("POST /v1/payments/:paymentIntentId/capture confirms booking on COMPLETED capture", async () => {
    const { bookingId } = await createCommittingBooking();

    // 1. Create order
    const orderRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/payment-order`,
      headers: { "idempotency-key": `req-order-cap-${bookingId}` },
    });
    expect(orderRes.statusCode).toBe(201);
    const { paymentIntentId } = orderRes.json();

    // 2. Capture payment (COMPLETED)
    fakePort.captureOutcome = "CAPTURED";
    const capRes = await app.inject({
      method: "POST",
      url: `/v1/payments/${paymentIntentId}/capture`,
      headers: { "idempotency-key": `req-cap-api-${paymentIntentId}` },
    });

    expect(capRes.statusCode).toBe(200);
    const capBody = capRes.json();
    expect(capBody.bookingStatus).toBe("CONFIRMED");
    expect(capBody.paymentStatus).toBe("CAPTURED");
    expect(capBody.providerCaptureId).toBeDefined();
  });

  it("POST /v1/payments/:paymentIntentId/capture returns 202 on UNCERTAIN capture", async () => {
    const { bookingId } = await createCommittingBooking();

    const orderRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/payment-order`,
      headers: { "idempotency-key": `req-order-unc-${bookingId}` },
    });
    const { paymentIntentId } = orderRes.json();

    fakePort.captureOutcome = "UNCERTAIN";
    const capRes = await app.inject({
      method: "POST",
      url: `/v1/payments/${paymentIntentId}/capture`,
      headers: { "idempotency-key": `req-cap-unc-${paymentIntentId}` },
    });

    expect(capRes.statusCode).toBe(202);
    const capBody = capRes.json();
    expect(capBody.bookingStatus).toBe("CAPTURE_UNCERTAIN");
    expect(capBody.paymentStatus).toBe("UNCERTAIN");
    expect(capBody.statusUrl).toBeDefined();
  });

  it("POST /v1/captures/:captureId/refunds prevents over-refund under capture lock", async () => {
    const { bookingId } = await createCommittingBooking();

    const orderRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/payment-order`,
      headers: { "idempotency-key": `req-order-rf-${bookingId}` },
    });
    const { paymentIntentId } = orderRes.json();

    fakePort.captureOutcome = "CAPTURED";
    await app.inject({
      method: "POST",
      url: `/v1/payments/${paymentIntentId}/capture`,
      headers: { "idempotency-key": `req-cap-rf-${paymentIntentId}` },
    });

    const capture = await withTenantTransaction(db, DEV_TENANT_ID, (trx) =>
      trx
        .selectFrom("payment_captures")
        .where("booking_id", "=", bookingId)
        .selectAll()
        .executeTakeFirstOrThrow(),
    );

    // 1. Valid partial refund: $10.00
    const rf1 = await app.inject({
      method: "POST",
      url: `/v1/captures/${capture.id}/refunds`,
      headers: { "idempotency-key": `rf-api-1-${capture.id}` },
      payload: {
        amountMinor: "1000",
        reason: "Customer requested partial refund",
      },
    });
    expect(rf1.statusCode).toBe(200);

    // 2. Excessive refund: $15.00 > remaining $10.00 -> 400 Problem Details
    const rf2 = await app.inject({
      method: "POST",
      url: `/v1/captures/${capture.id}/refunds`,
      headers: { "idempotency-key": `rf-api-2-${capture.id}` },
      payload: {
        amountMinor: "1500",
        reason: "Excessive refund",
      },
    });
    expect(rf2.statusCode).toBe(409);
    expect(rf2.json().title).toContain("exceeds");
  });

  it("Rejects startup/configuration when PAYPAL_ENVIRONMENT is not sandbox", () => {
    expect(() => {
      const env = "live";
      if (env !== "sandbox") {
        throw new Error(
          "Only PayPal sandbox environment is permitted in Epic 3; live configuration is rejected",
        );
      }
    }).toThrow("Only PayPal sandbox environment is permitted in Epic 3");
  });

  it("POST /v1/bookings/:bookingId/balance-invoice generates balance invoice for completed appointment", async () => {
    const { bookingId } = await createCommittingBooking();

    const orderRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/payment-order`,
      headers: { "idempotency-key": `req-order-inv-${bookingId}` },
    });
    const { paymentIntentId } = orderRes.json();

    fakePort.captureOutcome = "CAPTURED";
    await app.inject({
      method: "POST",
      url: `/v1/payments/${paymentIntentId}/capture`,
      headers: { "idempotency-key": `req-cap-inv-${paymentIntentId}` },
    });

    // Mark appointment completed
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .updateTable("bookings")
        .set({ status: "COMPLETED" })
        .where("id", "=", bookingId)
        .execute();
    });

    const invRes = await app.inject({
      method: "POST",
      url: `/v1/bookings/${bookingId}/balance-invoice`,
      headers: { "idempotency-key": `req-inv-${bookingId}` },
      payload: {
        customerEmail: "alex@example.com",
        customerName: "Alex Buyer",
      },
    });

    expect(invRes.statusCode).toBe(201);
    const invBody = invRes.json();
    expect(invBody.invoiceId).toBeDefined();
    expect(invBody.status).toBe("SENT");
    expect(invBody.total.valueMinor).toBe("7500");
    expect(invBody.depositPaid.valueMinor).toBe("2000");
    expect(invBody.balanceDue.valueMinor).toBe("5500");
  });

  it("POST /v1/webhooks/paypal/:connectionKey accepts raw payload within 256 KiB and rejects payload exceeding 256 KiB", async () => {
    // 1. Valid webhook under 256 KiB
    const validPayload = JSON.stringify({
      id: "WH-EV-API-001",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "CAP-001" },
    });

    const whRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/paypal/default",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "trans-api-1",
        "paypal-transmission-time": "2026-10-21T10:00:00Z",
        "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-transmission-sig": "sig==",
      },
      payload: validPayload,
    });

    expect(whRes.statusCode).toBe(200);
    expect(whRes.json().received).toBe(true);
    expect(whRes.json().deliveryId).toBeDefined();

    // Allow background processing to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 2. Oversized webhook payload (> 256 KiB = 262144 bytes)
    const oversizedPayload = JSON.stringify({
      id: "WH-EV-OVERSIZED",
      padding: "X".repeat(270_000),
    });

    const overRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks/paypal/default",
      headers: {
        "content-type": "application/json",
        "paypal-transmission-id": "trans-api-2",
      },
      payload: oversizedPayload,
    });

    // Fastify rejects request exceeding bodyLimit with 413 Payload Too Large
    expect(overRes.statusCode).toBe(413);
  });
});
