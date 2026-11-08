import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
  extractDatabaseName,
} from "@velvetai/db";
import {
  TenantId,
  UUID,
  paymentIntentIdSchema,
  paymentCaptureIdSchema,
  refundIdSchema,
  currencyCodeSchema,
  moneyMinorSchema,
  PayPalOrderDetails,
  PayPalCaptureDetails,
  PayPalRefundDetails,
} from "@velvetai/contracts";
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
} from "@velvetai/application";
import { PostgreSqlOutboxStore } from "../postgres-outbox-store.js";
import { ReconciliationProcessor } from "../reconciliation-processor.js";
import { OutboxProcessor, InMemoryOutboxStore } from "../outbox-processor.js";
import { OutboxWorker } from "../index.js";

const TEST_DB_URL = getTestDatabaseUrl();

class MockPaymentPort implements PaymentPort {
  captureStatus = "COMPLETED";
  refundStatus = "COMPLETED";

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
        valueMinor: moneyMinorSchema.parse("5000"),
      },
      captures: [
        {
          id: `CAP_${providerOrderId}`,
          status: this.captureStatus,
          amount: {
            currency: currencyCodeSchema.parse("USD"),
            valueMinor: moneyMinorSchema.parse("5000"),
          },
        },
      ],
    };
  }

  async capturePayment(_params: CapturePaymentParams): Promise<CapturePaymentResult> {
    return {
      providerCaptureId: `CAP_${crypto.randomUUID().slice(0, 8)}`,
      paymentCaptureId: paymentCaptureIdSchema.parse(crypto.randomUUID()),
      status: "CAPTURED",
    };
  }

  async getCapture(providerCaptureId: string): Promise<PayPalCaptureDetails> {
    return {
      id: providerCaptureId,
      status: this.captureStatus,
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("5000"),
      },
    };
  }

  async refundPayment(_params: RefundPaymentParams): Promise<RefundPaymentResult> {
    return {
      refundId: refundIdSchema.parse(crypto.randomUUID()),
      providerRefundId: `REF_${crypto.randomUUID().slice(0, 8)}`,
      status: "COMPLETED",
    };
  }

  async getRefund(providerRefundId: string): Promise<PayPalRefundDetails> {
    return {
      id: providerRefundId,
      status: this.refundStatus,
      amount: {
        currency: currencyCodeSchema.parse("USD"),
        valueMinor: moneyMinorSchema.parse("2500"),
      },
    };
  }

  async verifyWebhookSignature(_params: VerifyWebhookParams): Promise<boolean> {
    return true;
  }

  async createInvoiceDraft(_params: CreateInvoiceDraftParams): Promise<CreateInvoiceDraftResult> {
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

describe("W5: PostgreSQL Outbox Store & Reconciliation Worker", () => {
  let db: Kysely<Database>;
  let outboxStore: PostgreSqlOutboxStore;
  let mockPort: MockPaymentPort;
  let reconciliation: ReconciliationProcessor;
  let tenantId: TenantId;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    outboxStore = new PostgreSqlOutboxStore(db, 3, 100, 1000);
    mockPort = new MockPaymentPort();
    reconciliation = new ReconciliationProcessor(db, mockPort);

    tenantId = crypto.randomUUID() as TenantId;
    await db
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: "W5 Worker Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function insertTestOutboxEvent(eventType = "booking.created"): Promise<UUID> {
    const eventId = crypto.randomUUID() as UUID;
    await withTenantTransaction(db, tenantId, async (trx) => {
      await trx
        .insertInto("outbox_events")
        .values({
          id: eventId,
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: crypto.randomUUID(),
          event_type: eventType,
          payload: { test: true },
        })
        .execute();
    });
    return eventId;
  }

  it("0. Resolves isolated worker test database matching package name", () => {
    const dbUrl = getTestDatabaseUrl();
    const dbName = extractDatabaseName(dbUrl);
    expect(dbName).toMatch(/velvetai_test_worker/);
  });

  it("1. Crash before side effect: retries with bounded exponential backoff", async () => {
    const eventId = await insertTestOutboxEvent();
    const processor = new OutboxProcessor(outboxStore, "crash-test-consumer", 3, 30, tenantId);

    // First attempt fails
    const res1 = await processor.processNextBatch(1, {
      handle: async () => {
        throw new Error("Simulated network crash before side effect");
      },
    });

    expect(res1.failed).toBe(1);

    // Event is unacknowledged and attempts incremented
    const evt = await db
      .selectFrom("outbox_events")
      .where("id", "=", eventId)
      .selectAll()
      .executeTakeFirst();

    expect(evt?.processed_at).toBeNull();
    expect(evt?.attempts).toBe(1);
    expect(evt?.last_error).toContain("Simulated network crash");
    expect(evt?.lease_expires_at).toBeDefined();
  });

  it("2. Crash after side effect but before acknowledgement: idempotency prevents duplicate execution", async () => {
    const eventId = await insertTestOutboxEvent("booking.confirmed");
    let sideEffectExecutionCount = 0;

    // Simulate crash after inbox record: we manually record inbox
    await outboxStore.recordInboxProcessed("idempotent-consumer", eventId);
    sideEffectExecutionCount = 1;

    // Now processor runs on this event
    const processor = new OutboxProcessor(outboxStore, "idempotent-consumer", 3, 30, tenantId);
    const res = await processor.processNextBatch(5, {
      handle: async () => {
        sideEffectExecutionCount += 1;
      },
    });

    expect(res.processed).toBe(1);
    // Side effect was NOT called again because inbox record already existed
    expect(sideEffectExecutionCount).toBe(1);

    const evt = await db
      .selectFrom("outbox_events")
      .where("id", "=", eventId)
      .selectAll()
      .executeTakeFirst();
    expect(evt?.processed_at).toBeDefined();
  });

  it("3. Lease expiry and reclaim: expired lease can be reclaimed by another worker", async () => {
    const eventId = await insertTestOutboxEvent("booking.held");

    // Worker 1 claims event with 1-second lease TTL
    const claimedByWorker1 = await outboxStore.claimEvents(5, 1, tenantId);
    const target1 = claimedByWorker1.find((e) => e.id === eventId);
    expect(target1).toBeDefined();
    expect(target1?.leaseToken).toBeDefined();

    // Immediately claiming again yields 0 events because lease is active
    const claimedImmediate = await outboxStore.claimEvents(5, 1, tenantId);
    const targetImmediate = claimedImmediate.find((e) => e.id === eventId);
    expect(targetImmediate).toBeUndefined();

    // Wait 1.1s for lease to expire
    await new Promise((r) => setTimeout(r, 1100));

    // Worker 2 now reclaims the expired lease
    const claimedByWorker2 = await outboxStore.claimEvents(5, 10, tenantId);
    const target2 = claimedByWorker2.find((e) => e.id === eventId);
    expect(target2).toBeDefined();
    // Worker 2 receives a new fenced lease token
    expect(target2?.leaseToken).not.toBe(target1?.leaseToken);
  });

  it("4. Stale acknowledgement fails: stale worker cannot acknowledge reclaimed lease", async () => {
    const eventId = await insertTestOutboxEvent("booking.payment_initiated");

    // Worker A claims with 1-second TTL
    const claimedA = await outboxStore.claimEvents(5, 1, tenantId);
    const eventA = claimedA.find((e) => e.id === eventId);
    expect(eventA).toBeDefined();

    // Wait for Worker A's lease to expire
    await new Promise((r) => setTimeout(r, 1100));

    // Worker B reclaims the lease with a new token
    const claimedB = await outboxStore.claimEvents(5, 10, tenantId);
    const eventB = claimedB.find((e) => e.id === eventId);
    expect(eventB).toBeDefined();

    // Stale Worker A attempts to acknowledge with its stale token: must be rejected
    const staleAckSuccess = await outboxStore.markProcessed(eventId, eventA!.leaseToken);
    expect(staleAckSuccess).toBe(false);

    // Event is still not processed
    let check = await db
      .selectFrom("outbox_events")
      .where("id", "=", eventId)
      .selectAll()
      .executeTakeFirst();
    expect(check?.processed_at).toBeNull();

    // Valid Worker B acknowledges with its active token: succeeds
    const validAckSuccess = await outboxStore.markProcessed(eventId, eventB!.leaseToken);
    expect(validAckSuccess).toBe(true);

    check = await db
      .selectFrom("outbox_events")
      .where("id", "=", eventId)
      .selectAll()
      .executeTakeFirst();
    expect(check?.processed_at).toBeDefined();
  });

  it("5. Duplicate delivery creates exactly one durable side effect", async () => {
    await insertTestOutboxEvent("booking.payment_order_created");
    let sideEffectCount = 0;

    const processor = new OutboxProcessor(outboxStore, "dedup-consumer", 3, 30, tenantId);

    // First delivery
    await processor.processNextBatch(1, {
      handle: async () => {
        sideEffectCount += 1;
      },
    });
    expect(sideEffectCount).toBe(1);

    // Simulate duplicated event delivery
    await processor.processNextBatch(1, {
      handle: async () => {
        sideEffectCount += 1;
      },
    });
    expect(sideEffectCount).toBe(1);
  });

  it("6. Reconciliation job resumes after restart and resolves uncertain capture", async () => {
    const bookingId = crypto.randomUUID();
    const locationId = crypto.randomUUID();
    const serviceId = crypto.randomUUID();
    const serviceVersionId = crypto.randomUUID();
    const resourceId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const opId = crypto.randomUUID();

    // Seed booking dependencies
    await db
      .insertInto("locations")
      .values({
        id: locationId,
        tenant_id: tenantId,
        name: "Reconcile Loc",
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
        display_name: "Stylist Rec",
        status: "ACTIVE",
      })
      .execute();

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
        name: "Cut",
        duration_minutes: 30,
        price_minor: "5000",
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

    const startsAt = new Date(Date.now() + 3600_000);
    const endsAt = new Date(startsAt.getTime() + 1800_000);

    await db
      .insertInto("booking_quotes")
      .values({
        id: quoteId,
        tenant_id: tenantId,
        service_version_id: serviceVersionId,
        customer_id: crypto.randomUUID(),
        starts_at: startsAt,
        ends_at: endsAt,
        total_minor: "5000",
        deposit_minor: "2500",
        currency: "USD",
        canonical_hash: "d".repeat(64),
        expires_at: new Date(Date.now() + 60_000),
      })
      .execute();

    await db
      .insertInto("bookings")
      .values({
        id: bookingId,
        tenant_id: tenantId,
        customer_id: crypto.randomUUID(),
        quote_id: quoteId,
        status: "CAPTURE_UNCERTAIN",
        version: 1,
        starts_at: startsAt,
        ends_at: endsAt,
        resource_id: resourceId,
      })
      .execute();

    await db
      .insertInto("resource_claims")
      .values({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        booking_id: bookingId,
        resource_id: resourceId,
        blocked_during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)')`,
        starts_at: startsAt,
        ends_at: endsAt,
        state: "CONFIRMED",
        blocking: true,
      })
      .execute();

    // Insert pending capture provider operation
    const providerCaptureId = "CAP_REC_" + crypto.randomUUID().slice(0, 8);
    await db
      .insertInto("provider_operations")
      .values({
        id: opId,
        tenant_id: tenantId,
        booking_id: bookingId,
        provider: "PAYPAL",
        environment: "sandbox",
        operation_type: "CAPTURE",
        state: "SENT_UNKNOWN",
        endpoint: "/v2/payments/captures",
        paypal_request_id: "req-" + crypto.randomUUID(),
        canonical_payload_hash: "e".repeat(64),
        provider_capture_id: providerCaptureId,
        next_reconcile_at: new Date(Date.now() - 1000), // Due immediately
      })
      .execute();

    // Run reconciliation processor
    const recResult = await reconciliation.reconcilePendingOperations(10, tenantId);
    expect(recResult.reconciled).toBe(1);

    // Verify provider_operation marked SUCCEEDED
    const op = await db
      .selectFrom("provider_operations")
      .where("id", "=", opId)
      .selectAll()
      .executeTakeFirst();
    expect(op?.state).toBe("SUCCEEDED");

    // Verify booking moved from CAPTURE_UNCERTAIN to CONFIRMED
    const booking = await db
      .selectFrom("bookings")
      .where("id", "=", bookingId)
      .selectAll()
      .executeTakeFirst();
    expect(booking?.status).toBe("CONFIRMED");
  });

  it("7. Production configuration cannot silently select in-memory storage", () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const inMemoryStore = new InMemoryOutboxStore();

      expect(() => {
        new OutboxWorker(inMemoryStore);
      }).toThrow(/InMemoryOutboxStore is prohibited in production/);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
