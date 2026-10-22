import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, Kysely } from "kysely";
import { Database } from "../schema.js";
import { withTenantTransaction } from "../index.js";
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
});
