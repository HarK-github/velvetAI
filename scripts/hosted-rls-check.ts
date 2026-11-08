import { createDatabaseClient, sql } from "../packages/db/src/index.ts";
import { loadRootEnv, extractDatabaseName } from "./load-env.js";

const SYNTHETIC_DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DUMMY_TENANT_B_ID = "01932b10-0000-7000-8000-000000000099";

async function main() {
  loadRootEnv();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("ERROR: DATABASE_URL is required to run hosted-rls-check.");
    process.exit(1);
  }

  const dbName = extractDatabaseName(dbUrl);
  console.log(`Target database: ${dbName}`);
  console.log("Starting Hosted Database RLS & Tenant Isolation Verification...\n");

  const db = createDatabaseClient(dbUrl);

  try {
    // 1. Role Introspection
    const roleInfo = await sql<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(
      db,
    );

    const currentUser = roleInfo.rows[0];
    console.log("1. Connected Role Security Attributes:");
    console.log(`   - Role Name:    ${currentUser?.rolname}`);
    console.log(`   - Is Superuser: ${currentUser?.rolsuper} (must be false)`);
    console.log(`   - Has BypassRLS: ${currentUser?.rolbypassrls} (must be false)`);

    if (currentUser?.rolsuper || currentUser?.rolbypassrls) {
      console.error(
        "FAIL: Runtime connection role must NOT be superuser and must NOT have BYPASSRLS.",
      );
      process.exit(1);
    }

    // 2. Count RLS-enforced and forced tables
    const rlsCount = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity`.execute(
      db,
    );
    const totalRlsTables = Number(rlsCount.rows[0]?.count ?? 0);
    console.log(`2. FORCE ROW LEVEL SECURITY Tables: ${totalRlsTables} tables protected.\n`);

    // 3. Test: Unscoped Query Fails Closed (0 rows)
    const unscopedLocations = await db.selectFrom("locations").selectAll().execute();
    const unscopedServices = await db.selectFrom("services").selectAll().execute();
    console.log("3. Unscoped Direct Query (No app.tenant_id set):");
    console.log(`   - Locations visible: ${unscopedLocations.length} (expected: 0)`);
    console.log(`   - Services visible:  ${unscopedServices.length} (expected: 0)`);

    if (unscopedLocations.length !== 0 || unscopedServices.length !== 0) {
      console.error("FAIL: Missing tenant context did NOT fail closed! Rows leaked.");
      process.exit(1);
    }

    // 4. Test: Tenant A can see its own seeded records
    let tenantALocationsCount = 0;
    let tenantAServicesCount = 0;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${SYNTHETIC_DEV_TENANT_ID}, true)`.execute(trx);
      const locs = await trx.selectFrom("locations").selectAll().execute();
      const srvs = await trx.selectFrom("services").selectAll().execute();
      tenantALocationsCount = locs.length;
      tenantAServicesCount = srvs.length;
    });

    console.log(`4. Tenant A Context (${SYNTHETIC_DEV_TENANT_ID}):`);
    console.log(`   - Locations visible: ${tenantALocationsCount}`);
    console.log(`   - Services visible:  ${tenantAServicesCount}`);

    // 5. Test: Cross-Tenant Isolation (Tenant B context cannot read Tenant A rows)
    let crossTenantLeakCount = 0;
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${DUMMY_TENANT_B_ID}, true)`.execute(trx);
      const locs = await trx.selectFrom("locations").selectAll().execute();
      const srvs = await trx.selectFrom("services").selectAll().execute();
      crossTenantLeakCount = locs.length + srvs.length;
    });

    console.log(`5. Cross-Tenant Isolation (Tenant B Context ${DUMMY_TENANT_B_ID}):`);
    console.log(`   - Tenant A rows visible to Tenant B: ${crossTenantLeakCount} (expected: 0)`);

    if (crossTenantLeakCount !== 0) {
      console.error("FAIL: Cross-tenant isolation breach! Tenant B could read Tenant A rows.");
      process.exit(1);
    }

    console.log("\nRLS & Cross-Tenant Isolation Verification: PASSED");
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("hosted-rls-check failed with error:", err.message);
  process.exit(1);
});
