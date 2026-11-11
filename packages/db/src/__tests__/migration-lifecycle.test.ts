import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, Kysely } from "kysely";
import crypto from "node:crypto";
import { Database } from "../schema.js";
import { seedTenantContext } from "./test-helper.js";
import { migrateToLatest, migrateDown } from "../migrator.js";
import { createDatabaseClient, withTenantTransaction } from "../client.js";
import { getTestDatabaseUrl } from "../test-db.js";

const MIGRATION_TEST_DB_URL = getTestDatabaseUrl("migration");

describe("PostgreSQL 17 Migration Lifecycle, Constraints & RLS Verification", () => {
  let adminDb: Kysely<Database>;

  beforeAll(async () => {
    adminDb = createDatabaseClient(MIGRATION_TEST_DB_URL, { min: 1, max: 5 });
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
    expect(role.rolcanlogin).toBe(false);

    // Verify FORCE ROW LEVEL SECURITY across all 29 tenant tables
    const tenantTables = [
      "locations",
      "customers",
      "memberships",
      "services",
      "service_versions",
      "resources",
      "availability_rules",
      "booking_quotes",
      "bookings",
      "resource_claims",
      "booking_hold_snapshots",
      "buyer_confirmations",
      "committed_intents",
      "idempotency_records",
      "outbox_events",
      "audit_events",
      "provider_connections",
      "provider_operations",
      "payment_intents",
      "payment_captures",
      "refund_reservations",
      "verified_provider_events",
      "financial_journal_entries",
      "financial_journal_lines",
      "invoices",
      "judge_runs",
      "judge_abuse_runs",
      "demo_schedule_fixtures",
      "synthetic_history",
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

    expect(policies.rows.length).toBe(29);
    for (const p of policies.rows) {
      // The qual must match NULLIF(current_setting('app.tenant_id', true), '')::uuid
      expect(p.qual).toContain("app.tenant_id");
      expect(p.qual).toContain("::uuid");
      expect(p.qual).not.toContain("tenant_id::text");
    }
  });

  it("4. Migration Rollback and Re-apply Proof: verifies down() and up() idempotency", async () => {
    // Rollback migration 0009
    await migrateDown(adminDb);

    // After rollback of 0009, judge_abuse_runs table should be absent
    const rolledBackJudgeAbuseRuns = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'judge_abuse_runs'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackJudgeAbuseRuns.rows[0]?.exists).toBe(false);

    // Rollback migration 0007
    await migrateDown(adminDb);

    // After rollback of 0007, judge_runs table and binding constraint should be absent
    const rolledBackJudgeRuns = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'judge_runs'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackJudgeRuns.rows[0]?.exists).toBe(false);

    const rolledBackBinding = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_constraint
        WHERE conname = 'chk_resource_claim_source_booking_binding'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackBinding.rows[0]?.exists).toBe(false);

    // Rollback migration 0005
    await migrateDown(adminDb);

    // After rollback of 0005, self_membership_select_policy should be absent
    const rolledBackPolicy = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_policies
        WHERE tablename = 'memberships' AND policyname = 'self_membership_select_policy'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackPolicy.rows[0]?.exists).toBe(false);

    // Rollback migration 0004
    await migrateDown(adminDb);

    // After rollback of 0004, lease_token should be absent from outbox_events
    const rolledBackLease = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'outbox_events' AND column_name = 'lease_token'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackLease.rows[0]?.exists).toBe(false);

    // Rollback migration 0003
    await migrateDown(adminDb);

    // After rollback of 0003, provider_operations should be absent
    const rolledBackOps = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'provider_operations'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackOps.rows[0]?.exists).toBe(false);

    // Rollback migration 0002
    await migrateDown(adminDb);

    // After rollback of 0002, 0002 tables and constraints should be absent
    const rolledBackSnapshots = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'booking_hold_snapshots'
      ) as exists
    `.execute(adminDb);
    expect(rolledBackSnapshots.rows[0]?.exists).toBe(false);

    // Re-apply migrations to latest
    await migrateToLatest(adminDb);

    // Verify tables and constraints restored
    const restoredSnapshots = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'booking_hold_snapshots'
      ) as exists
    `.execute(adminDb);
    expect(restoredSnapshots.rows[0]?.exists).toBe(true);

    const restoredJudgeRuns = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'judge_runs'
      ) as exists
    `.execute(adminDb);
    expect(restoredJudgeRuns.rows[0]?.exists).toBe(true);

    const restoredJudgeAbuseRuns = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'judge_abuse_runs'
      ) as exists
    `.execute(adminDb);
    expect(restoredJudgeAbuseRuns.rows[0]?.exists).toBe(true);

    const restoredBinding = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_constraint
        WHERE conname = 'chk_resource_claim_source_booking_binding'
      ) as exists
    `.execute(adminDb);
    expect(restoredBinding.rows[0]?.exists).toBe(true);

    const restoredOps = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'provider_operations'
      ) as exists
    `.execute(adminDb);
    expect(restoredOps.rows[0]?.exists).toBe(true);

    const restoredPolicy = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_policies
        WHERE tablename = 'memberships' AND policyname = 'self_membership_select_policy'
      ) as exists
    `.execute(adminDb);
    expect(restoredPolicy.rows[0]?.exists).toBe(true);

    // Verify CHECK constraint restored
    const checkConstraint = await sql<{ conname: string }>`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'chk_resource_claim_blocking_state'
    `.execute(adminDb);
    expect(checkConstraint.rows.length).toBe(1);
  }, 30_000);

  it("5. Payment core ledger migration 0003 schema, constraints and append-only rules proof", async () => {
    // 1. Verify CHECK constraints for payment state machines & payload limits
    const constraints = await sql<{ conname: string }>`
      SELECT conname
      FROM pg_constraint
      WHERE conname IN (
        'chk_provider_op_state',
        'chk_webhook_payload_length',
        'chk_line_debit_credit',
        'chk_payment_intent_state',
        'chk_payment_capture_state',
        'chk_refund_reservation_state'
      )
    `.execute(adminDb);

    expect(constraints.rows.length).toBeGreaterThanOrEqual(6);

    // 2. Verify append-only and balance triggers on financial journal entries and lines
    const triggers = await sql<{ tgname: string }>`
      SELECT tgname
      FROM pg_trigger
      WHERE tgname IN (
        'trg_protect_financial_journal_entries_update',
        'trg_protect_financial_journal_entries_delete',
        'trg_protect_financial_journal_lines_insert',
        'trg_protect_financial_journal_lines_update',
        'trg_protect_financial_journal_lines_delete',
        'trg_validate_journal_balance'
      )
    `.execute(adminDb);

    expect(triggers.rows.length).toBe(6);

    // 3. Verify payment_expires_at column on bookings
    const bookingCol = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'bookings'
          AND column_name = 'payment_expires_at'
      ) as exists
    `.execute(adminDb);

    expect(bookingCol.rows[0]?.exists).toBe(true);
  });

  it("6. Financial journal database integrity: enforces balance and immutability via triggers", async () => {
    const seed = await seedTenantContext(adminDb, "journal");
    const tenantId = seed.tenantId;
    const quoteId = crypto.randomUUID();
    const bookingId = crypto.randomUUID();

    await withTenantTransaction(adminDb, tenantId, async (trx) => {
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantId,
          service_version_id: seed.serviceVersionId,
          customer_id: seed.actorUserId,
          starts_at: new Date(Date.now() + 86400000),
          ends_at: new Date(Date.now() + 90000000),
          total_minor: "5000",
          deposit_minor: "2500",
          currency: "USD",
          canonical_hash: "hash-quote-1",
          expires_at: new Date(Date.now() + 300000),
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantId,
          customer_id: seed.actorUserId,
          quote_id: quoteId,
          status: "COMMITTING",
          version: 1,
          starts_at: new Date(Date.now() + 86400000),
          ends_at: new Date(Date.now() + 90000000),
        })
        .execute();
    });

    // A. Unbalanced entry cannot commit as POSTED
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        const entryId = crypto.randomUUID();
        await trx
          .insertInto("financial_journal_entries")
          .values({
            id: entryId,
            tenant_id: tenantId,
            booking_id: bookingId,
            entry_type: "DEPOSIT_CAPTURE",
            reference_id: "ref-unbalanced",
            currency: "USD",
            status: "DRAFT",
          })
          .execute();

        // Line with 2500 debit and 0 credit
        await trx
          .insertInto("financial_journal_lines")
          .values({
            id: crypto.randomUUID(),
            journal_entry_id: entryId,
            tenant_id: tenantId,
            account: "ASSET:PAYPAL_CLEARING",
            debit_minor: "2500",
            credit_minor: "0",
            currency: "USD",
          })
          .execute();

        // Update to POSTED without offsetting credit
        await trx
          .updateTable("financial_journal_entries")
          .set({ status: "POSTED", posted_at: new Date() })
          .where("id", "=", entryId)
          .execute();
      }),
    ).rejects.toThrow(/Unbalanced journal entry/);

    // B. Post a properly balanced entry
    const validEntryId = crypto.randomUUID();
    const lineDebitId = crypto.randomUUID();
    const lineCreditId = crypto.randomUUID();

    await withTenantTransaction(adminDb, tenantId, async (trx) => {
      await trx
        .insertInto("financial_journal_entries")
        .values({
          id: validEntryId,
          tenant_id: tenantId,
          booking_id: bookingId,
          entry_type: "DEPOSIT_CAPTURE",
          reference_id: "ref-valid",
          currency: "USD",
          status: "DRAFT",
        })
        .execute();

      await trx
        .insertInto("financial_journal_lines")
        .values([
          {
            id: lineDebitId,
            journal_entry_id: validEntryId,
            tenant_id: tenantId,
            account: "ASSET:PAYPAL_CLEARING",
            debit_minor: "2500",
            credit_minor: "0",
            currency: "USD",
          },
          {
            id: lineCreditId,
            journal_entry_id: validEntryId,
            tenant_id: tenantId,
            account: "LIABILITY:CUSTOMER_DEPOSIT",
            debit_minor: "0",
            credit_minor: "2500",
            currency: "USD",
          },
        ])
        .execute();

      await trx
        .updateTable("financial_journal_entries")
        .set({ status: "POSTED", posted_at: new Date() })
        .where("id", "=", validEntryId)
        .execute();
    });

    // C. Adding a line after posting fails visibly
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        await trx
          .insertInto("financial_journal_lines")
          .values({
            id: crypto.randomUUID(),
            journal_entry_id: validEntryId,
            tenant_id: tenantId,
            account: "EXPENSE:FEE",
            debit_minor: "100",
            credit_minor: "0",
            currency: "USD",
          })
          .execute();
      }),
    ).rejects.toThrow(/Cannot add lines to a posted financial journal entry/);

    // D. Updating a posted line fails visibly
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        await trx
          .updateTable("financial_journal_lines")
          .set({ debit_minor: "3000" })
          .where("id", "=", lineDebitId)
          .execute();
      }),
    ).rejects.toThrow(/Posted financial journal lines cannot be modified/);

    // E. Deleting a posted line fails visibly
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        await trx.deleteFrom("financial_journal_lines").where("id", "=", lineCreditId).execute();
      }),
    ).rejects.toThrow(/Posted financial journal lines cannot be deleted/);

    // F. Updating a posted entry fails visibly
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        await trx
          .updateTable("financial_journal_entries")
          .set({ reference_id: "tampered" })
          .where("id", "=", validEntryId)
          .execute();
      }),
    ).rejects.toThrow(/Posted financial journal entries cannot be modified/);

    // G. Deleting a posted entry fails visibly
    await expect(
      withTenantTransaction(adminDb, tenantId, async (trx) => {
        await trx.deleteFrom("financial_journal_entries").where("id", "=", validEntryId).execute();
      }),
    ).rejects.toThrow(/Posted financial journal entries cannot be deleted/);
  });

  it("7. Canonical RLS setting consistency: all tenant policies inspect app.tenant_id", async () => {
    const policies = await sql<{
      tablename: string;
      policyname: string;
      qual: string;
      with_check: string;
    }>`
      SELECT tablename, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
    `.execute(adminDb);

    expect(policies.rows.length).toBeGreaterThan(0);

    for (const row of policies.rows) {
      if (row.policyname === "self_membership_select_policy") {
        expect(row.qual).toContain("app.user_id");
        expect(row.with_check ?? "").toBe("");
        continue;
      }
      if (row.qual) {
        expect(row.qual).toContain("app.tenant_id");
        expect(row.qual).not.toContain("app.current_tenant_id");
      }
      if (row.with_check) {
        expect(row.with_check).toContain("app.tenant_id");
        expect(row.with_check).not.toContain("app.current_tenant_id");
      }
    }
  });

  it("8. Unordered migration proof: verifies allowUnorderedMigrations applies 0006-style migration after 0007", async () => {
    let upExecuted = false;
    const { Migrator } = await import("kysely");
    const testMigrator = new Migrator({
      db: adminDb,
      allowUnorderedMigrations: true,
      provider: {
        async getMigrations() {
          return {
            "0001_initial_schema": { async up() {}, async down() {} },
            "0002_slot_claim_rls_hardening": { async up() {}, async down() {} },
            "0003_payment_core_ledger": { async up() {}, async down() {} },
            "0004_outbox_lease_hardening": { async up() {}, async down() {} },
            "0005_self_membership_rls": { async up() {}, async down() {} },
            "0006_approval_signed_intent": {
              async up() {
                upExecuted = true;
              },
              async down() {},
            },
            "0007_judge_tenant_seed_and_reset": { async up() {}, async down() {} },
            "0009_judge_abuse_runs": { async up() {}, async down() {} },
          };
        },
      },
    });

    const { error, results } = await testMigrator.migrateToLatest();
    expect(error).toBeUndefined();
    expect(upExecuted).toBe(true);
    expect(results?.find((r) => r.migrationName === "0006_approval_signed_intent")?.status).toBe(
      "Success",
    );

    // Clean up the test migration entry from kysely_migration table
    await sql`DELETE FROM kysely_migration WHERE name = '0006_approval_signed_intent'`.execute(
      adminDb,
    );
  });

  it("9. Resource claims source binding check & GiST exclusion with demo fixtures", async () => {
    const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";
    const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
    const resourceId = crypto.randomUUID();
    const locId = crypto.randomUUID();
    const slotStart = new Date("2026-12-01T10:00:00.000Z");
    const slotEnd = new Date("2026-12-01T11:00:00.000Z");

    await withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
      await trx
        .insertInto("tenants")
        .values({
          id: JUDGE_TENANT_ID,
          name: "Judge Studio",
          default_currency: "USD",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      await trx
        .insertInto("locations")
        .values({
          id: locId,
          tenant_id: JUDGE_TENANT_ID,
          name: `Judge Location ${crypto.randomUUID().slice(0, 8)}`,
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: resourceId,
          tenant_id: JUDGE_TENANT_ID,
          location_id: locId,
          resource_type: "ROOM",
          display_name: "Judge Room 1",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    });

    // A. Inserting a BOOKING claim with booking_id IS NULL fails chk_resource_claim_source_booking_binding
    await expect(
      withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: null as any,
            claim_source: "BOOKING",
            resource_id: resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
          })
          .execute();
      }),
    ).rejects.toThrow(/chk_resource_claim_source_booking_binding/);

    // B. Inserting a DEMO_FIXTURE claim in the dev tenant fails chk_resource_claim_source_booking_binding
    await expect(
      withTenantTransaction(adminDb, DEV_TENANT_ID as any, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: DEV_TENANT_ID,
            booking_id: null as any,
            claim_source: "DEMO_FIXTURE",
            resource_id: resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "CONFIRMED",
            blocking: true,
          })
          .execute();
      }),
    ).rejects.toThrow(/chk_resource_claim_source_booking_binding/);

    // C. Inserting a DEMO_FIXTURE claim with non-null booking_id fails chk_resource_claim_source_booking_binding
    await expect(
      withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: crypto.randomUUID(),
            claim_source: "DEMO_FIXTURE",
            resource_id: resourceId,
            starts_at: slotStart,
            ends_at: slotEnd,
            blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
            state: "CONFIRMED",
            blocking: true,
          })
          .execute();
      }),
    ).rejects.toThrow(/chk_resource_claim_source_booking_binding/);

    // D. Inserting a valid DEMO_FIXTURE claim in judge tenant with booking_id IS NULL succeeds
    const fixtureClaimId = crypto.randomUUID();
    await withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
      await trx
        .insertInto("resource_claims")
        .values({
          id: fixtureClaimId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: null as any,
          claim_source: "DEMO_FIXTURE",
          resource_id: resourceId,
          starts_at: slotStart,
          ends_at: slotEnd,
          blocked_during: sql`tstzrange(${slotStart.toISOString()}::timestamptz, ${slotEnd.toISOString()}::timestamptz, '[)')`,
          state: "CONFIRMED",
          blocking: true,
        })
        .execute();
    });

    // E. Inserting an overlapping blocking claim raises GiST exclusion 23P01
    await expect(
      withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: null as any,
            claim_source: "DEMO_FIXTURE",
            resource_id: resourceId,
            starts_at: new Date("2026-12-01T10:30:00.000Z"),
            ends_at: new Date("2026-12-01T11:30:00.000Z"),
            blocked_during: sql`tstzrange('2026-12-01T10:30:00.000Z'::timestamptz, '2026-12-01T11:30:00.000Z'::timestamptz, '[)')`,
            state: "CONFIRMED",
            blocking: true,
          })
          .execute();
      }),
    ).rejects.toThrow(/no_overlapping_claims/);

    // Cleanup fixture claim
    await withTenantTransaction(adminDb, JUDGE_TENANT_ID as any, async (trx) => {
      await trx.deleteFrom("resource_claims").where("id", "=", fixtureClaimId).execute();
    });
  });
});
