import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, Kysely } from "kysely";
import crypto from "node:crypto";
import { Database } from "../schema.js";
import {
  TEST_DB_URL,
  seedTenantContext,
} from "./test-helper.js";
import { migrateToLatest, migrateDown } from "../migrator.js";
import { createDatabaseClient, withTenantTransaction } from "../client.js";

describe("PostgreSQL 17 Migration Lifecycle, Constraints & RLS Verification", () => {
  let adminDb: Kysely<Database>;

  beforeAll(async () => {
    adminDb = createDatabaseClient(TEST_DB_URL, { min: 1, max: 5 });
    // Ensure migrated to latest
    await migrateToLatest(adminDb);
  });

  afterAll(async () => {
    await adminDb.destroy();
  });

  it("1. Constraint and index inspection: verify GiST, CHECK, and B-tree indexes exist", async () => {
    // Verify no_overlapping_claims exclusion constraint
    const exclusionCheck = await sql<{ conname: string; contype: string }>`
      SELECT conname, contype::text
      FROM pg_constraint
      WHERE conname = 'no_overlapping_claims'
    `.execute(adminDb);
    expect(exclusionCheck.rows.length).toBe(1);
    expect(exclusionCheck.rows[0]?.contype).toBe("x"); // 'x' = exclusion constraint

    // Verify chk_resource_claim_blocking_state check constraint
    const checkConstraint = await sql<{ conname: string; contype: string }>`
      SELECT conname, contype::text
      FROM pg_constraint
      WHERE conname = 'chk_resource_claim_blocking_state'
    `.execute(adminDb);
    expect(checkConstraint.rows.length).toBe(1);
    expect(checkConstraint.rows[0]?.contype).toBe("c"); // 'c' = check constraint

    // Verify calendar index and partial expiry index
    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'resource_claims'
        AND indexname IN ('resource_claim_calendar_idx', 'resource_claim_expiry_idx')
    `.execute(adminDb);
    const indexNames = indexes.rows.map((r) => r.indexname);
    expect(indexNames).toContain("resource_claim_calendar_idx");
    expect(indexNames).toContain("resource_claim_expiry_idx");
  });

  it("2. Blocking-state integrity: proves blocking cannot drift from resource-claim state", async () => {
    const seed = await seedTenantContext(adminDb, "blocking-chk");
    const slotStart = new Date("2026-11-05T14:00:00.000Z");
    const slotEnd = new Date("2026-11-05T14:30:00.000Z");
    const bookingId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();

    await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: seed.tenantId,
          service_version_id: seed.serviceVersionId,
          customer_id: seed.actorUserId,
          starts_at: slotStart,
          ends_at: slotEnd,
          total_minor: "5000",
          deposit_minor: "1500",
          currency: "USD",
          canonical_hash: "hash-blocking-test",
          expires_at: new Date(Date.now() + 600_000),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: seed.tenantId,
          customer_id: seed.actorUserId,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          hold_expires_at: new Date(Date.now() + 600_000),
          starts_at: slotStart,
          ends_at: slotEnd,
          resource_id: seed.resourceId,
        })
        .execute();
    });

    // Subtest A: Inserting EXPIRED state with blocking = true MUST fail via check constraint
    let expiredBlockingFailed = false;
    try {
      await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seed.tenantId,
            booking_id: bookingId,
            resource_id: seed.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "EXPIRED",
            blocking: true, // INVALID DRIFT: expired cannot be blocking
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === "23514" || pgErr.constraint === "chk_resource_claim_blocking_state") {
        expiredBlockingFailed = true;
      }
    }
    expect(expiredBlockingFailed).toBe(true);

    // Subtest B: Inserting CANCELLED state with blocking = true MUST fail
    let cancelledBlockingFailed = false;
    try {
      await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seed.tenantId,
            booking_id: bookingId,
            resource_id: seed.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "CANCELLED",
            blocking: true, // INVALID DRIFT
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23514") cancelledBlockingFailed = true;
    }
    expect(cancelledBlockingFailed).toBe(true);

    // Subtest C: Inserting RELEASED state with blocking = true MUST fail
    let releasedBlockingFailed = false;
    try {
      await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seed.tenantId,
            booking_id: bookingId,
            resource_id: seed.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "RELEASED",
            blocking: true, // INVALID DRIFT
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23514") releasedBlockingFailed = true;
    }
    expect(releasedBlockingFailed).toBe(true);

    // Subtest D: Inserting HELD state with blocking = false MUST fail
    let heldNonBlockingFailed = false;
    try {
      await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seed.tenantId,
            booking_id: bookingId,
            resource_id: seed.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: false, // INVALID DRIFT: active states cannot be non-blocking
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23514") heldNonBlockingFailed = true;
    }
    expect(heldNonBlockingFailed).toBe(true);

    // Subtest E: Inserting CONFIRMED state with blocking = false MUST fail
    let confirmedNonBlockingFailed = false;
    try {
      await withTenantTransaction(adminDb, seed.tenantId, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: seed.tenantId,
            booking_id: bookingId,
            resource_id: seed.resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "CONFIRMED",
            blocking: false, // INVALID DRIFT
          })
          .execute();
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23514") confirmedNonBlockingFailed = true;
    }
    expect(confirmedNonBlockingFailed).toBe(true);
  });

  it("3. Restricted runtime role attributes & RLS policy inspection", async () => {
    // Verify velvet_runtime role attributes (non-superuser, NOBYPASSRLS)
    const roleInfo = await sql<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
      FROM pg_roles
      WHERE rolname = 'velvet_runtime'
    `.execute(adminDb);

    expect(roleInfo.rows.length).toBe(1);
    const role = roleInfo.rows[0]!;
    expect(role.rolsuper).toBe(false);
    expect(role.rolbypassrls).toBe(false);
    expect(role.rolcanlogin).toBe(true);

    // Verify FORCE ROW LEVEL SECURITY across all tenant tables
    const tenantTables = [
      "locations", "customers", "memberships", "services",
      "service_versions", "resources", "availability_rules", "booking_quotes",
      "bookings", "resource_claims", "booking_hold_snapshots", "buyer_confirmations",
      "committed_intents", "idempotency_records", "outbox_events", "audit_events"
    ];

    const rlsTables = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = ANY(${tenantTables})
    `.execute(adminDb);

    expect(rlsTables.rows.length).toBe(tenantTables.length);
    for (const row of rlsTables.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Verify tenant_isolation_policy compares tenant_id as UUID without text cast on column
    const policies = await sql<{
      tablename: string;
      policyname: string;
      qual: string;
    }>`
      SELECT tablename, policyname, qual
      FROM pg_policies
      WHERE policyname = 'tenant_isolation_policy'
    `.execute(adminDb);

    expect(policies.rows.length).toBeGreaterThanOrEqual(16);
    for (const p of policies.rows) {
      // The qual must match NULLIF(current_setting('app.tenant_id', true), '')::uuid
      expect(p.qual).toContain("app.tenant_id");
      expect(p.qual).toContain("::uuid");
      expect(p.qual).not.toContain("tenant_id::text");
    }
  });

  it("4. Migration Rollback and Re-apply Proof: verifies down() and up() idempotency", async () => {
    // Rollback migration 0002
    await migrateDown(adminDb);

    // After rollback, 0002 tables and constraints should be absent
    const rolledBackSnapshots = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'booking_hold_snapshots'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackSnapshots.rows[0]?.exists).toBe(false);

    // Re-apply migration 0002
    await migrateToLatest(adminDb);

    // Verify table restored
    const restoredSnapshots = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'booking_hold_snapshots'
      ) as exists
    `.execute(adminDb);
    expect(restoredSnapshots.rows[0]?.exists).toBe(true);

    // Verify CHECK constraint restored
    const checkConstraint = await sql<{ conname: string }>`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'chk_resource_claim_blocking_state'
    `.execute(adminDb);
    expect(checkConstraint.rows.length).toBe(1);
  });
});
