import crypto from "node:crypto";
import { Kysely } from "kysely";
import {
  Database,
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  getTestDatabaseUrl,
  assertSafeTestDatabaseTeardown,
} from "../index.js";
import { TenantId, LocationId, ServiceId, ResourceId, UserId } from "@velvetai/contracts";

export const TEST_DB_URL = getTestDatabaseUrl();

export async function setupTestDatabase(): Promise<Kysely<Database>> {
  const db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 20 });
  await migrateToLatest(db);
  return db;
}

export async function createSingleConnectionDb(): Promise<Kysely<Database>> {
  return createDatabaseClient(TEST_DB_URL, { min: 1, max: 1 });
}

export async function createRestrictedSingleConnectionDb(
  adminDb?: Kysely<Database>,
): Promise<Kysely<Database>> {
  if (process.env.RESTRICTED_DATABASE_URL) {
    return createDatabaseClient(process.env.RESTRICTED_DATABASE_URL, { min: 1, max: 1 });
  }

  const ephemeralRole = `test_rt_${crypto.randomBytes(4).toString("hex")}`;
  const ephemeralPass = crypto.randomBytes(16).toString("hex");

  const effectiveAdmin = adminDb ?? (await setupTestDatabase());
  const { sql } = await import("kysely");
  await sql
    .raw(`CREATE ROLE ${ephemeralRole} WITH LOGIN PASSWORD '${ephemeralPass}' NOBYPASSRLS INHERIT;`)
    .execute(effectiveAdmin);
  await sql
    .raw(`GRANT velvet_runtime TO ${ephemeralRole} WITH INHERIT TRUE, SET TRUE;`)
    .execute(effectiveAdmin);

  const parsedUrl = new URL(TEST_DB_URL);
  parsedUrl.username = ephemeralRole;
  parsedUrl.password = ephemeralPass;

  const client = createDatabaseClient(parsedUrl.toString(), { min: 1, max: 1 });
  const originalDestroy = client.destroy.bind(client);
  client.destroy = async () => {
    assertSafeTestDatabaseTeardown(TEST_DB_URL);
    await originalDestroy();
    try {
      await sql.raw(`DROP ROLE IF EXISTS ${ephemeralRole};`).execute(effectiveAdmin);
    } catch {
      // ignore cleanup errors on drop
    }
    if (!adminDb) {
      await effectiveAdmin.destroy();
    }
  };

  return client;
}

export interface SeededTenantContext {
  tenantId: TenantId;
  locationId: LocationId;
  serviceId: ServiceId;
  serviceVersionId: string;
  resourceId: ResourceId;
  actorUserId: UserId;
}

export async function seedTenantContext(
  db: Kysely<Database>,
  prefix = "test",
): Promise<SeededTenantContext> {
  const tenantId = crypto.randomUUID() as TenantId;
  const locationId = crypto.randomUUID() as LocationId;
  const serviceId = crypto.randomUUID() as ServiceId;
  const serviceVersionId = crypto.randomUUID();
  const resourceId = crypto.randomUUID() as ResourceId;
  const actorUserId = crypto.randomUUID() as UserId;

  // Insert tenant
  await db
    .insertInto("tenants")
    .values({
      id: tenantId,
      name: `${prefix}-tenant-${Date.now()}`,
      default_currency: "USD",
      status: "ACTIVE",
    })
    .execute();

  // Insert user (global table)
  await db
    .insertInto("app_users")
    .values({
      id: actorUserId,
      oidc_subject: `oidc|${actorUserId}`,
      email_ciphertext: `${prefix}@example.com`,
    })
    .execute();

  // Tenant-scoped rows must be executed within tenant transaction for RLS
  await withTenantTransaction(db, tenantId, async (trx) => {
    // Insert location
    await trx
      .insertInto("locations")
      .values({
        id: locationId,
        tenant_id: tenantId,
        name: `${prefix}-location`,
        timezone: "America/New_York",
        status: "ACTIVE",
      })
      .execute();

    // Insert membership
    await trx
      .insertInto("memberships")
      .values({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        user_id: actorUserId,
        role: "OWNER",
        role_version: 1,
      })
      .execute();

    // Insert service and version
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
        name: `${prefix}-haircut`,
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

    // Insert resource unit
    await trx
      .insertInto("resources")
      .values({
        id: resourceId,
        tenant_id: tenantId,
        location_id: locationId,
        resource_type: "ROOM",
        display_name: `${prefix}-Room 1`,
        status: "ACTIVE",
      })
      .execute();
  });

  return {
    tenantId,
    locationId,
    serviceId,
    serviceVersionId,
    resourceId,
    actorUserId,
  };
}
