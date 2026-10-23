import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import { Database } from "../schema.js";
import { withTenantTransaction, withUserTransaction } from "../index.js";
import {
  setupTestDatabase,
  createRestrictedSingleConnectionDb,
  seedTenantContext,
  SeededTenantContext,
} from "./test-helper.js";

describe("RLS Pool Leakage & Isolation Tests (Restricted Role, Single Connection Pool)", () => {
  let adminDb: Kysely<Database>;
  let singleDb: Kysely<Database>;
  let tenantA: SeededTenantContext;
  let tenantB: SeededTenantContext;

  beforeAll(async () => {
    adminDb = await setupTestDatabase();
    tenantA = await seedTenantContext(adminDb, "rls-a");
    tenantB = await seedTenantContext(adminDb, "rls-b");

    // Connect as velvet_runtime (NOBYPASSRLS, non-owner role) with pool size exactly 1
    singleDb = await createRestrictedSingleConnectionDb(adminDb);
  });

  afterAll(async () => {
    await singleDb.destroy();
    await adminDb.destroy();
  });

  it("1. Missing tenant context fails closed: direct select returns 0 rows", async () => {
    // Directly querying tenant tables on raw connection without setting app.tenant_id
    const locations = await singleDb.selectFrom("locations").selectAll().execute();
    expect(locations.length).toBe(0);

    const services = await singleDb.selectFrom("services").selectAll().execute();
    expect(services.length).toBe(0);

    const setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.tenant_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");
  });

  it("2. Missing tenant context fails closed: direct insert throws RLS violation", async () => {
    const orphanLocationId = crypto.randomUUID();
    let insertFailed = false;

    try {
      await singleDb
        .insertInto("locations")
        .values({
          id: orphanLocationId,
          tenant_id: tenantA.tenantId,
          name: "unauthorized-insert",
          timezone: "UTC",
          status: "ACTIVE",
        })
        .execute();
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // 42501 = insufficient_privilege / violates row-level security policy
      if (pgErr.code === "42501" || pgErr.message?.includes("row-level security")) {
        insertFailed = true;
      }
    }

    expect(insertFailed).toBe(true);
  });

  it("3. Commit leaves no residual tenant context on pooled connection", async () => {
    // Execute a successful transaction under Tenant A
    await withTenantTransaction(singleDb, tenantA.tenantId, async (trx) => {
      const locs = await trx.selectFrom("locations").selectAll().execute();
      expect(locs.length).toBeGreaterThanOrEqual(1);
      expect(locs.every((l) => l.tenant_id === tenantA.tenantId)).toBe(true);
    });

    // Next statement on same pooled connection must have empty context
    const setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.tenant_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");

    const locs = await singleDb.selectFrom("locations").selectAll().execute();
    expect(locs.length).toBe(0);
  });

  it("4. Rollback leaves no residual tenant context on pooled connection", async () => {
    try {
      await withTenantTransaction(singleDb, tenantA.tenantId, async (_trx) => {
        // Intentionally throw inside transaction to trigger rollback
        throw new Error("intentional rollback for tenant A");
      });
    } catch {
      // expected
    }

    // Next statement on same pooled connection must have clean context
    const setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.tenant_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");

    // Check Tenant B sees only Tenant B
    await withTenantTransaction(singleDb, tenantB.tenantId, async (trx) => {
      const locs = await trx.selectFrom("locations").selectAll().execute();
      expect(locs.length).toBeGreaterThanOrEqual(1);
      expect(locs.every((l) => l.tenant_id === tenantB.tenantId)).toBe(true);
    });
  });

  it("5. Tenant alternation: strict isolation between Tenant A and Tenant B", async () => {
    for (let i = 0; i < 5; i++) {
      // Query Tenant A
      await withTenantTransaction(singleDb, tenantA.tenantId, async (trx) => {
        const locs = await trx.selectFrom("locations").selectAll().execute();
        expect(locs.every((l) => l.tenant_id === tenantA.tenantId)).toBe(true);
        expect(locs.some((l) => l.tenant_id === tenantB.tenantId)).toBe(false);
      });

      // Query Tenant B immediately after on same connection
      await withTenantTransaction(singleDb, tenantB.tenantId, async (trx) => {
        const locs = await trx.selectFrom("locations").selectAll().execute();
        expect(locs.every((l) => l.tenant_id === tenantB.tenantId)).toBe(true);
        expect(locs.some((l) => l.tenant_id === tenantA.tenantId)).toBe(false);
      });
    }
  });

  it("6. Cross-tenant write injection is rejected by WITH CHECK policy", async () => {
    let checkViolation = false;

    await withTenantTransaction(singleDb, tenantA.tenantId, async (trx) => {
      try {
        // Attempt to insert a row with Tenant B's tenant_id while in Tenant A's transaction
        await trx
          .insertInto("locations")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantB.tenantId, // spoofed tenant_id
            name: "spoofed-location",
            timezone: "UTC",
            status: "ACTIVE",
          })
          .execute();
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string };
        if (pgErr.code === "42501" || pgErr.message?.includes("row-level security policy")) {
          checkViolation = true;
        }
      }
    });

    expect(checkViolation).toBe(true);
  });

  it("7. User A cannot read User B memberships under self-membership RLS policy", async () => {
    // Under User A context, only User A's membership is returned
    await withUserTransaction(singleDb, tenantA.actorUserId, async (trx) => {
      const rows = await trx.selectFrom("memberships").selectAll().execute();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((m) => m.user_id === tenantA.actorUserId)).toBe(true);
      expect(rows.some((m) => m.user_id === tenantB.actorUserId)).toBe(false);
    });

    // Under User B context, only User B's membership is returned
    await withUserTransaction(singleDb, tenantB.actorUserId, async (trx) => {
      const rows = await trx.selectFrom("memberships").selectAll().execute();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((m) => m.user_id === tenantB.actorUserId)).toBe(true);
      expect(rows.some((m) => m.user_id === tenantA.actorUserId)).toBe(false);
    });
  });

  it("8. Missing app.user_id exposes zero memberships", async () => {
    // When neither app.tenant_id nor app.user_id is set, direct select exposes zero rows
    const memberships = await singleDb.selectFrom("memberships").selectAll().execute();
    expect(memberships.length).toBe(0);

    const setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.user_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");
  });

  it("9. app.user_id is cleared after commit/rollback on pool size one", async () => {
    // A: Successful commit
    await withUserTransaction(singleDb, tenantA.actorUserId, async (trx) => {
      const rows = await trx.selectFrom("memberships").selectAll().execute();
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    // Context must be empty on next query
    let setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.user_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");
    let zeroCheck = await singleDb.selectFrom("memberships").selectAll().execute();
    expect(zeroCheck.length).toBe(0);

    // B: Transaction rollback
    try {
      await withUserTransaction(singleDb, tenantA.actorUserId, async (_trx) => {
        throw new Error("intentional rollback for user context");
      });
    } catch {
      // expected
    }

    // Context must still be empty on next query
    setting = await sql<{
      val: string | null;
    }>`SELECT current_setting('app.user_id', true) AS val`.execute(singleDb);
    expect(setting.rows[0]?.val ?? "").toBe("");
    zeroCheck = await singleDb.selectFrom("memberships").selectAll().execute();
    expect(zeroCheck.length).toBe(0);
  });

  it("10. Self-membership policy cannot insert, update, or delete memberships", async () => {
    await withUserTransaction(singleDb, tenantA.actorUserId, async (trx) => {
      // 1. SELECT is allowed
      const rows = await trx.selectFrom("memberships").selectAll().execute();
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // 2. UPDATE is not authorized by FOR SELECT policy (0 rows updated)
      const updateResult = await trx
        .updateTable("memberships")
        .set({ role: "SCHEDULER" })
        .where("user_id", "=", tenantA.actorUserId)
        .executeTakeFirst();
      expect(updateResult.numUpdatedRows).toBe(0n);

      // 3. DELETE is not authorized by FOR SELECT policy (0 rows deleted)
      const deleteResult = await trx
        .deleteFrom("memberships")
        .where("user_id", "=", tenantA.actorUserId)
        .executeTakeFirst();
      expect(deleteResult.numDeletedRows).toBe(0n);

      // 4. INSERT is not authorized by FOR SELECT policy (throws 42501 RLS violation)
      let insertRejected = false;
      try {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantA.tenantId,
            user_id: tenantA.actorUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          })
          .execute();
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "42501") {
          insertRejected = true;
        }
      }
      expect(insertRejected).toBe(true);
    });
  });
});
