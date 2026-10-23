import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import {
  Database,
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { HoldReaperProcessor } from "../hold-reaper.js";

const TEST_DB_URL = getTestDatabaseUrl();

describe("Hold Reaper Processor (Requirement 6: Concurrent Replicas & Crash Recovery)", () => {
  let db: Kysely<Database>;
  let tenantId: string;
  let resourceId: string;
  let serviceVersionId: string;
  let customerId: string;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 15 });
    await migrateToLatest(db);

    tenantId = crypto.randomUUID();
    resourceId = crypto.randomUUID();
    serviceVersionId = crypto.randomUUID();
    customerId = crypto.randomUUID();

    // Global tenant & user
    await db
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: `reaper-test-${Date.now()}`,
        default_currency: "USD",
        status: "ACTIVE",
      })
      .execute();

    await db
      .insertInto("app_users")
      .values({
        id: customerId,
        oidc_subject: `reaper|${customerId}`,
        email_ciphertext: "reaper@example.com",
      })
      .execute();

    // Tenant-scoped setup
    await withTenantTransaction(db, tenantId, async (trx) => {
      const locationId = crypto.randomUUID();
      const serviceId = crypto.randomUUID();

      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: tenantId,
          name: "Reaper Clinic",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .execute();

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
          name: "Standard Cut",
          duration_minutes: 30,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "5000",
          base_deposit_minor: "1500",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: serviceVersionId })
        .where("id", "=", serviceId)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: resourceId,
          tenant_id: tenantId,
          location_id: locationId,
          resource_type: "ROOM",
          display_name: "Room R",
          status: "ACTIVE",
        })
        .execute();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("concurrent reaper replicas using FOR UPDATE SKIP LOCKED process all expired holds exactly once", async () => {
    const expiredCount = 12;
    const pastExpiry = new Date(Date.now() - 60_000); // 1 minute in the past

    // Seed 12 expired holds across distinct time slots
    await withTenantTransaction(db, tenantId, async (trx) => {
      for (let i = 0; i < expiredCount; i++) {
        const bookingId = crypto.randomUUID();
        const quoteId = crypto.randomUUID();
        const claimId = crypto.randomUUID();
        const slotStart = new Date(`2026-12-01T${10 + i}:00:00.000Z`);
        const slotEnd = new Date(`2026-12-01T${10 + i}:30:00.000Z`);

        await trx
          .insertInto("booking_quotes")
          .values({
            id: quoteId,
            tenant_id: tenantId,
            service_version_id: serviceVersionId,
            customer_id: customerId,
            starts_at: slotStart,
            ends_at: slotEnd,
            total_minor: "5000",
            deposit_minor: "1500",
            currency: "USD",
            canonical_hash: `reap-hash-${i}`,
            expires_at: pastExpiry,
          })
          .execute();

        await trx
          .insertInto("bookings")
          .values({
            id: bookingId,
            tenant_id: tenantId,
            customer_id: customerId,
            quote_id: quoteId,
            status: "HELD",
            version: 1,
            hold_expires_at: pastExpiry,
            starts_at: slotStart,
            ends_at: slotEnd,
            resource_id: resourceId,
          })
          .execute();

        await trx
          .insertInto("resource_claims")
          .values({
            id: claimId,
            tenant_id: tenantId,
            booking_id: bookingId,
            resource_id: resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
            hold_expires_at: pastExpiry,
          })
          .execute();
      }
    });

    // 3 concurrent reaper workers run simultaneously
    const reaper1 = new HoldReaperProcessor(db);
    const reaper2 = new HoldReaperProcessor(db);
    const reaper3 = new HoldReaperProcessor(db);

    const [res1, res2, res3] = await Promise.all([
      reaper1.reapOnce(5, tenantId),
      reaper2.reapOnce(5, tenantId),
      reaper3.reapOnce(5, tenantId),
    ]);

    const totalReapedBatch1 = res1.reapedCount + res2.reapedCount + res3.reapedCount;

    // Run another pass to reap any remaining
    const cleanupPass = await reaper1.reapOnce(20, tenantId);
    const totalReaped = totalReapedBatch1 + cleanupPass.reapedCount;

    expect(totalReaped).toBe(expiredCount);

    // Verify all claims transitioned to EXPIRED with blocking=false
    await withTenantTransaction(db, tenantId, async (trx) => {
      const remainingHeld = await trx
        .selectFrom("resource_claims")
        .where("tenant_id", "=", tenantId)
        .where("state", "=", "HELD")
        .selectAll()
        .execute();
      expect(remainingHeld.length).toBe(0);

      const expiredClaims = await trx
        .selectFrom("resource_claims")
        .where("tenant_id", "=", tenantId)
        .where("state", "=", "EXPIRED")
        .where("blocking", "=", false)
        .selectAll()
        .execute();
      expect(expiredClaims.length).toBeGreaterThanOrEqual(expiredCount);

      const expiredBookings = await trx
        .selectFrom("bookings")
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "EXPIRED")
        .selectAll()
        .execute();
      expect(expiredBookings.length).toBeGreaterThanOrEqual(expiredCount);
    });
  });

  it("crash recovery: a terminated/aborted worker does not lose holds; remaining worker reaps it", async () => {
    const bookingId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const pastExpiry = new Date(Date.now() - 30_000);
    const slotStart = new Date("2026-12-05T14:00:00.000Z");
    const slotEnd = new Date("2026-12-05T14:30:00.000Z");

    await withTenantTransaction(db, tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantId,
          service_version_id: serviceVersionId,
          customer_id: customerId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "crash-test-hash",
          expires_at: pastExpiry,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantId,
          customer_id: customerId,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          hold_expires_at: pastExpiry,
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: resourceId,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: tenantId,
          booking_id: bookingId,
          resource_id: resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "HELD",
          blocking: true,
          hold_expires_at: pastExpiry,
        })
        .execute();
    });

    // Simulate worker crashing halfway through transaction (e.g. killed process or unhandled error)
    try {
      await withTenantTransaction(db, tenantId, async (trx) => {
        // Worker acquires the lock
        const lockedClaim = await trx
          .selectFrom("resource_claims")
          .where("id", "=", claimId)
          .where("state", "=", "HELD")
          .forUpdate()
          .executeTakeFirst();

        expect(lockedClaim).toBeDefined();

        // Worker crashes before committing
        throw new Error("SIMULATED_WORKER_SIGKILL");
      });
    } catch (err: unknown) {
      expect((err as Error).message).toBe("SIMULATED_WORKER_SIGKILL");
    }

    // Row was NOT lost: a subsequent reaper run recovers and completes the expiration
    const survivorReaper = new HoldReaperProcessor(db);
    const recovered = await survivorReaper.reapOnce(10, tenantId);
    expect(recovered.reapedCount).toBeGreaterThanOrEqual(1);

    await withTenantTransaction(db, tenantId, async (trx) => {
      const claim = await trx
        .selectFrom("resource_claims")
        .where("id", "=", claimId)
        .selectAll()
        .executeTakeFirst();

      expect(claim?.state).toBe("EXPIRED");
      expect(claim?.blocking).toBe(false);
    });
  });
});
