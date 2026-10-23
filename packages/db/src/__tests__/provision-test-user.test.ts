import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDatabase } from "./test-helper.js";
import type { Database } from "../schema.js";
import type { Kysely } from "kysely";
import {
  provisionTestUser,
  redactId,
  SYNTHETIC_DEV_TENANT_ID,
  ALLOWED_ROLE,
} from "../../../../scripts/provision-test-user.js";

describe("Local Development Test User Provisioning", () => {
  let db: Kysely<Database>;
  const testSubject = `auth0|test_user_${Date.now()}`;
  let createdUserId: string | null = null;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterAll(async () => {
    if (createdUserId) {
      const { sql } = await import("kysely");
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.tenant_id', ${SYNTHETIC_DEV_TENANT_ID}, true)`.execute(
          trx,
        );
        await trx.deleteFrom("memberships").where("user_id", "=", createdUserId!).execute();
        await trx.deleteFrom("app_users").where("id", "=", createdUserId!).execute();
      });
    }
    await db.destroy();
  });

  it("1. Refuses execution in production environment (NODE_ENV=production)", async () => {
    await expect(
      provisionTestUser("auth0|prod_sub_attempt", {
        db,
        nodeEnv: "production",
      }),
    ).rejects.toThrow(/REFUSED: auth:provision-test-user cannot be run in production/);
  });

  it("2. Refuses empty or whitespace-only OIDC subjects", async () => {
    await expect(
      provisionTestUser("   ", {
        db,
        nodeEnv: "development",
      }),
    ).rejects.toThrow(/Auth0 OIDC subject cannot be empty/);
  });

  it("3. Provisions new test user into synthetic development tenant with strictly BUYER role", async () => {
    const res = await provisionTestUser(testSubject, {
      db,
      nodeEnv: "development",
    });

    expect(res).toBeDefined();
    expect(res.tenantId).toBe(SYNTHETIC_DEV_TENANT_ID);
    expect(res.role).toBe(ALLOWED_ROLE);
    expect(res.isNewUser).toBe(true);
    expect(res.isNewMembership).toBe(true);
    expect(typeof res.userId).toBe("string");
    expect(typeof res.membershipId).toBe("string");

    createdUserId = res.userId;

    // Verify database record in app_users
    const userInDb = await db
      .selectFrom("app_users")
      .where("id", "=", res.userId)
      .selectAll()
      .executeTakeFirst();

    expect(userInDb).toBeDefined();
    expect(userInDb?.oidc_subject).toBe(testSubject);

    // Verify membership record in synthetic development tenant
    const { sql } = await import("kysely");
    const membershipInDb = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${SYNTHETIC_DEV_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("id", "=", res.membershipId)
        .selectAll()
        .executeTakeFirst();
    });

    expect(membershipInDb).toBeDefined();
    expect(membershipInDb?.user_id).toBe(res.userId);
    expect(membershipInDb?.tenant_id).toBe(SYNTHETIC_DEV_TENANT_ID);
    expect(membershipInDb?.role).toBe("BUYER");
    expect(membershipInDb?.role_version).toBe(1);
    expect(membershipInDb?.revoked_at).toBeNull();

    // Verify strictly does NOT have OWNER, MANAGER, or SUPPORT
    expect(membershipInDb?.role).not.toBe("OWNER");
    expect(membershipInDb?.role).not.toBe("MANAGER");
    expect(membershipInDb?.role).not.toBe("SUPPORT");
  });

  it("4. Idempotency: Re-running provisioning for same subject reuses existing user and membership", async () => {
    expect(createdUserId).not.toBeNull();

    const secondRun = await provisionTestUser(testSubject, {
      db,
      nodeEnv: "development",
    });

    expect(secondRun.userId).toBe(createdUserId);
    expect(secondRun.tenantId).toBe(SYNTHETIC_DEV_TENANT_ID);
    expect(secondRun.role).toBe("BUYER");
    expect(secondRun.isNewUser).toBe(false);
    expect(secondRun.isNewMembership).toBe(false);

    // Assert zero duplicate records created
    const usersCount = await db
      .selectFrom("app_users")
      .where("oidc_subject", "=", testSubject)
      .select((eb) => eb.fn.count("id").as("count"))
      .executeTakeFirst();

    expect(Number(usersCount?.count)).toBe(1);

    const { sql } = await import("kysely");
    const membershipsCount = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${SYNTHETIC_DEV_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", createdUserId!)
        .where("tenant_id", "=", SYNTHETIC_DEV_TENANT_ID)
        .select((eb) => eb.fn.count("id").as("count"))
        .executeTakeFirst();
    });

    expect(Number(membershipsCount?.count)).toBe(1);
  });

  it("5. ID redaction helper masks sensitive identifiers", () => {
    const rawUuid = "01932b10-0000-7000-8000-000000000001";
    const redacted = redactId(rawUuid);

    expect(redacted).toBe("01932b10...0001");
    expect(redacted).not.toBe(rawUuid);
    expect(redactId("")).toBe("***");
  });
});
