import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { Kysely, sql } from "kysely";
import {
  createDatabaseClient,
  Database,
  getTestDatabaseUrl,
  withTenantTransaction,
} from "@velvetai/db";
import { bookingProofResponseSchema, DomainError } from "@velvetai/contracts";
import { BookingProofService, JudgeResetService, maskFirst4Last4 } from "../index.js";

const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";
const FORBIDDEN_KEY_PATTERN = /(token|secret|note|email|password)/i;

function collectAllKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllKeys(item, keys);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      collectAllKeys(v, keys);
    }
  }
  return keys;
}

describe("WP 08 Part B: BookingProofService & Masking Helper", () => {
  let db: Kysely<Database>;
  const actorUserId = crypto.randomUUID();
  const transmissionId = `tx-proof-${Date.now()}`;
  const bookingId = crypto.randomUUID();

  beforeAll(async () => {
    db = createDatabaseClient(getTestDatabaseUrl());

    await db
      .insertInto("app_users")
      .values({
        id: actorUserId,
        oidc_subject: `auth0|proof-svc-${Date.now()}`,
        email_ciphertext: "proof-buyer-secret@example.com",
      })
      .execute();

    const resetService = new JudgeResetService(db);
    await resetService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: actorUserId,
      now: new Date(),
    });

    const t0 = new Date(Date.UTC(2027, 8, 10, 12, 0, 0));
    const tHoldEnd = new Date(t0.getTime() + 5 * 60_000);
    const tApproved = new Date(t0.getTime() + 10_000);
    const tCommitted = new Date(t0.getTime() + 15_000);
    const tOrder = new Date(t0.getTime() + 20_000);
    const tLost = new Date(t0.getTime() + 25_000);
    const tWebhook = new Date(t0.getTime() + 30_000);
    const tCaptured = new Date(t0.getTime() + 35_000);

    const runTag = bookingId.slice(0, 8);
    const rawOrderId = `26B9ORDER${runTag}125W`;
    const rawCaptureId = `91P4CAPT${runTag}790B`;
    const rawSnapshotHash = "9f3a11223344556677889900aabbccdd11223344556677889900aabbccddc21b";
    const rawIdempKey = `secret-commit-key-do-not-expose-raw-${runTag}`;
    const rawCustomerEmail = "sensitive.pii.buyer@example.com";

    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      const sv = await trx
        .selectFrom("service_versions")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .select(["id", "cancellation_policy_id"])
        .executeTakeFirstOrThrow();

      // Dedicated per-run location & resource so repeated test runs never collide on GiST
      const locationId = crypto.randomUUID();
      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: JUDGE_TENANT_ID,
          name: `Proof Test Loc ${bookingId.slice(0, 8)}`,
          timezone: "UTC",
          status: "ACTIVE",
        })
        .execute();

      const resource = { id: crypto.randomUUID() };
      await trx
        .insertInto("resources")
        .values({
          id: resource.id,
          tenant_id: JUDGE_TENANT_ID,
          location_id: locationId,
          resource_type: "CHAIR",
          display_name: `Proof Chair ${bookingId.slice(0, 8)}`,
          status: "ACTIVE",
        })
        .execute();

      const customerId = crypto.randomUUID();
      await trx
        .insertInto("customers")
        .values({
          id: customerId,
          tenant_id: JUDGE_TENANT_ID,
          email_ciphertext: rawCustomerEmail,
          display_name_ciphertext: "Sensitive Name",
          status: "ACTIVE",
        })
        .execute();

      const quoteId = crypto.randomUUID();
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: JUDGE_TENANT_ID,
          service_version_id: sv.id,
          customer_id: customerId,
          starts_at: new Date("2027-09-10T14:00:00.000Z"),
          ends_at: new Date("2027-09-10T15:00:00.000Z"),
          total_minor: "7500",
          deposit_minor: "2000",
          currency: "USD",
          canonical_hash: "quote-hash",
          expires_at: tHoldEnd,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: JUDGE_TENANT_ID,
          customer_id: customerId,
          quote_id: quoteId,
          status: "CONFIRMED",
          version: 4,
          hold_expires_at: tHoldEnd,
          starts_at: new Date("2027-09-10T14:00:00.000Z"),
          ends_at: new Date("2027-09-10T15:00:00.000Z"),
          resource_id: resource.id,
          created_at: t0,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          claim_source: "BOOKING",
          resource_id: resource.id,
          starts_at: new Date("2027-09-10T14:00:00.000Z"),
          ends_at: new Date("2027-09-10T15:00:00.000Z"),
          blocked_during: sql`tstzrange('2027-09-10T14:00:00.000Z'::timestamptz, '2027-09-10T15:00:00.000Z'::timestamptz, '[)')`,
          blocking: true,
          state: "CONFIRMED",
          created_at: t0,
        })
        .execute();

      await trx
        .insertInto("booking_hold_snapshots")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          service_version_id: sv.id,
          resource_id: resource.id,
          starts_at: new Date("2027-09-10T14:00:00.000Z"),
          ends_at: new Date("2027-09-10T15:00:00.000Z"),
          total_minor: "7500",
          deposit_minor: "2000",
          currency: "USD",
          currency_scale: 2,
          cancellation_policy_id: sv.cancellation_policy_id,
          cancellation_policy_version: 1,
          cancellation_policy_hash: "cpolhash",
          merchant_id: JUDGE_TENANT_ID,
          client_id: "proof-client",
          actor_id: actorUserId,
          canonical_hash: rawSnapshotHash,
          created_at: t0,
        })
        .execute();

      await trx
        .insertInto("buyer_confirmations")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          confirmation_jti: crypto.randomUUID(),
          token_hash: "deadbeef".repeat(8),
          buyer_user_id: actorUserId,
          interaction_locator: `loc_proof_${Date.now()}`,
          consumed_at: tApproved,
          expires_at: tHoldEnd,
          created_at: t0,
        })
        .execute();

      await trx
        .insertInto("committed_intents")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          intent_jti: crypto.randomUUID(),
          booking_id: bookingId,
          committed_at: tCommitted,
        })
        .execute();

      await trx
        .insertInto("idempotency_records")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          actor_id: actorUserId,
          client_id: "proof-client",
          operation: "commit_booking.v1",
          idempotency_key: rawIdempKey,
          request_hash: "reqhash",
          state: "COMPLETED",
          response_status: 200,
          response_body: { bookingId, status: "COMMITTING" },
          expires_at: new Date(t0.getTime() + 86_400_000),
          created_at: tCommitted,
        })
        .execute();

      const piId = crypto.randomUUID();
      await trx
        .insertInto("payment_intents")
        .values({
          id: piId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          provider_connection_id: null,
          provider_order_id: rawOrderId,
          amount_minor: "2000",
          currency: "USD",
          state: "CAPTURED",
          payment_expires_at: tHoldEnd,
          request_id: `req-pi-${Date.now()}`,
          created_at: tOrder,
        })
        .execute();

      const capId = crypto.randomUUID();
      await trx
        .insertInto("payment_captures")
        .values({
          id: capId,
          tenant_id: JUDGE_TENANT_ID,
          payment_intent_id: piId,
          booking_id: bookingId,
          provider_capture_id: rawCaptureId,
          amount_minor: "2000",
          currency: "USD",
          state: "COMPLETED",
          captured_at: tCaptured,
          created_at: tCaptured,
        })
        .execute();

      await trx
        .insertInto("provider_operations")
        .values([
          {
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: bookingId,
            provider: "PAYPAL",
            environment: "sandbox",
            operation_type: "ORDER_CREATE",
            state: "SUCCEEDED",
            endpoint: "/v2/checkout/orders",
            paypal_request_id: `pp-order-${Date.now()}`,
            canonical_payload_hash: "ohash",
            provider_order_id: rawOrderId,
            attempt_count: 1,
            created_at: tOrder,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: bookingId,
            provider: "PAYPAL",
            environment: "sandbox",
            operation_type: "CAPTURE",
            state: "SUCCEEDED",
            endpoint: `/v2/checkout/orders/${rawOrderId}/capture`,
            paypal_request_id: `pp-cap-${Date.now()}`,
            canonical_payload_hash: "chash",
            provider_order_id: rawOrderId,
            provider_capture_id: rawCaptureId,
            error_code: "FAULT_INJECTED",
            attempt_count: 2,
            last_attempt_at: tLost,
            created_at: tLost,
          },
        ])
        .execute();

      await trx
        .insertInto("verified_provider_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          provider_connection_id: null,
          environment: "sandbox",
          provider_event_id: `WH-${Date.now()}`,
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          transmission_id: transmissionId,
          resource_id: rawCaptureId,
          resource_type: "capture",
          reconciliation_state: "PROCESSED",
          verified_at: tWebhook,
        })
        .execute();

      const entryId = crypto.randomUUID();
      await trx
        .insertInto("financial_journal_entries")
        .values({
          id: entryId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          entry_type: "DEPOSIT_CAPTURE",
          reference_id: capId,
          currency: "USD",
          status: "DRAFT",
          posted_at: null,
          created_at: tCaptured,
        })
        .execute();

      await trx
        .insertInto("financial_journal_lines")
        .values([
          {
            id: crypto.randomUUID(),
            journal_entry_id: entryId,
            tenant_id: JUDGE_TENANT_ID,
            account: "ASSET:PAYPAL_CLEARING",
            debit_minor: "2000",
            credit_minor: "0",
            currency: "USD",
            created_at: tCaptured,
          },
          {
            id: crypto.randomUUID(),
            journal_entry_id: entryId,
            tenant_id: JUDGE_TENANT_ID,
            account: "LIABILITY:CUSTOMER_DEPOSIT",
            debit_minor: "0",
            credit_minor: "2000",
            currency: "USD",
            created_at: tCaptured,
          },
        ])
        .execute();

      await trx
        .updateTable("financial_journal_entries")
        .set({ status: "POSTED", posted_at: tCaptured })
        .where("id", "=", entryId)
        .execute();
    });

    await db
      .insertInto("webhook_quarantine")
      .values({
        id: crypto.randomUUID(),
        connection_key: "default",
        environment: "sandbox",
        transmission_id: transmissionId,
        transmission_time: tWebhook.toISOString(),
        cert_url: "https://api.sandbox.paypal.com/cert.pem",
        auth_algo: "SHA256withRSA",
        transmission_sig: "sig-secret",
        raw_payload: JSON.stringify({ note: "private booking note", email: rawCustomerEmail }),
        payload_sha256: "payloadsha",
        body_bytes_length: 64,
        verification_state: "VERIFIED",
        received_at: tWebhook,
      })
      .execute();
  });

  afterAll(async () => {
    await db
      .deleteFrom("webhook_quarantine")
      .where("transmission_id", "=", transmissionId)
      .execute();
    await db.destroy();
  });

  it("masks PayPal IDs and SHA-256 hashes as first4…last4 and redacts <= 8 char values", () => {
    expect(maskFirst4Last4("26B9ORDER8841125W")).toBe("26B9…125W");
    expect(
      maskFirst4Last4("9f3a11223344556677889900aabbccdd11223344556677889900aabbccddc21b"),
    ).toBe("9f3a…c21b");
    expect(maskFirst4Last4("  12345678  ")).toBe("****");
    expect(maskFirst4Last4("short")).toBe("****");
  });

  it("builds complete proof with all sections, chronological timeline, balanced ledger, and zero leaked secrets or PII", async () => {
    const service = new BookingProofService(db);
    const proof = await service.getBookingProof(JUDGE_TENANT_ID, bookingId);
    const parsed = bookingProofResponseSchema.parse(proof);

    expect(parsed.bookingId).toBe(bookingId);
    expect(parsed.status).toBe("CONFIRMED");
    expect(parsed.timeline.map((e) => e.event)).toEqual([
      "HOLD_CREATED",
      "HUMAN_APPROVED",
      "COMMITTED",
      "PAYPAL_ORDER_CREATED",
      "CAPTURE_RESPONSE_LOST",
      "WEBHOOK_VERIFIED",
      "RECONCILED",
    ]);
    expect(parsed.intent).toMatchObject({
      sha256Prefix: "9f3a…c21b",
      algorithm: "ES256",
    });
    expect(parsed.confirmation?.consumed).toBe(true);
    expect(parsed.confirmation?.consumedAt).toBeDefined();
    expect(parsed.idempotency?.commitKeyHashPrefix).toMatch(/^[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(parsed.resourceClaim).toEqual({ blocking: true, state: "CONFIRMED" });
    expect(parsed.paypal).toEqual({
      environment: "sandbox",
      orderIdMasked: "26B9…125W",
      captureIdMasked: "91P4…790B",
      captureStatus: "COMPLETED",
    });
    expect(parsed.webhook).toEqual({
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      verification: "VERIFIED",
      reconciliation: "PROCESSED",
    });
    expect(parsed.ledger).toEqual({
      entries: 1,
      balanced: true,
      depositLiabilityMinor: "2000",
      currency: "USD",
    });
    expect(parsed.counts).toEqual({
      captures: 1,
      bookingsForHold: 1,
      journalEntriesForCapture: 1,
    });

    const keys = collectAllKeys(parsed);
    for (const k of keys) {
      expect(k).not.toMatch(FORBIDDEN_KEY_PATTERN);
    }

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain(`26B9ORDER${bookingId.slice(0, 8)}125W`);
    expect(serialized).not.toContain(`91P4CAPT${bookingId.slice(0, 8)}790B`);
    expect(serialized).not.toContain("secret-commit-key-do-not-expose-raw");
    expect(serialized).not.toContain("sensitive.pii.buyer@example.com");
    expect(serialized).not.toContain("private booking note");
    expect(serialized).not.toContain("deadbeef");
  });

  it("refuses proof access outside judge tenant", async () => {
    const service = new BookingProofService(db);
    await expect(
      service.getBookingProof("01932b10-0000-7000-8000-000000000001", bookingId),
    ).rejects.toThrow(DomainError);
  });
});
