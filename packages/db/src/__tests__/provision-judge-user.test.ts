import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDatabase } from "./test-helper.js";
import type { Database } from "../schema.js";
import type { Kysely } from "kysely";
import {
  provisionJudgeUser,
  ALLOWED_JUDGE_ROLE,
  validateJudgeSubject,
  JUDGE_TENANT_ID,
  DEV_TENANT_ID,
} from "../../../../scripts/provision-judge-user.js";

describe("Judge User Provisioning Script", () => {
  let db: Kysely<Database>;
  const testSubject = `auth0|672e811f582e2df5${Date.now()}`;
  let createdUserId: string | null = null;

  beforeAll(async () => {
    db = await setupTestDatabase();

    // Ensure judge tenant exists
    await db
      .insertInto("tenants")
      .values({
        id: JUDGE_TENANT_ID,
        name: "Velvet Judge Demo Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
  });

  afterAll(async () => {
    if (createdUserId) {
      const { sql } = await import("kysely");
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);
        await trx.deleteFrom("memberships").where("user_id", "=", createdUserId!).execute();
        await trx.deleteFrom("app_users").where("id", "=", createdUserId!).execute();
      });
    }
    await db.destroy();
  });

  it("1. Refuses execution in production environment (NODE_ENV=production) without ALLOW_HOSTED_SEED", async () => {
    await expect(
      provisionJudgeUser("auth0|672e811f582e2df5prod01", {
        db,
        nodeEnv: "production",
      }),
    ).rejects.toThrow(/REFUSED: auth:provision-judge-user cannot be run in production/);
  });

  it("2. Refuses empty or whitespace-only OIDC subjects", async () => {
    await expect(
      provisionJudgeUser("   ", {
        db,
        nodeEnv: "development",
      }),
    ).rejects.toThrow(/Auth0 OIDC subject cannot be empty/);

    expect(() => validateJudgeSubject("")).toThrow(/Auth0 OIDC subject cannot be empty/);
  });

  it("3. Refuses obvious placeholders (PASTE, YOUR_, <, >, example)", async () => {
    const placeholders = [
      "auth0|PASTE_JUDGE_USER_ID",
      "auth0|YOUR_USER_ID",
      "auth0|<user_id>",
      "auth0|>user_id<",
      "auth0|example1234567890",
      "google-oauth2|PASTE_HERE_12345",
      "auth0|paste_anything_here",
      "auth0|your_auth0_id_1234",
    ];

    for (const ph of placeholders) {
      expect(() => validateJudgeSubject(ph)).toThrow(/contains a placeholder pattern/);
      await expect(
        provisionJudgeUser(ph, {
          db,
          nodeEnv: "development",
        }),
      ).rejects.toThrow(/contains a placeholder pattern/);
    }
  });

  it("4. Refuses invalid subject formats (too short, underscores/non-alphanumeric, non-digit google-oauth2, other providers)", async () => {
    const invalidFormats = [
      "invalid-plain-username",
      "auth0|short",
      "auth0|with_underscore_here",
      "google-oauth2|notdigits",
      "google-oauth2|12345abc",
      "facebook|1234567890123456",
      "oauth2|1234567890123456",
      "github|1234567890123456",
    ];

    for (const inv of invalidFormats) {
      expect(() => validateJudgeSubject(inv)).toThrow(/Invalid subject format/);
      await expect(
        provisionJudgeUser(inv, {
          db,
          nodeEnv: "development",
        }),
      ).rejects.toThrow(/Invalid subject format/);
    }
  });

  it("5. Accepts valid auth0 (alphanumeric 16+) and google-oauth2 (digits) formats", () => {
    expect(validateJudgeSubject("auth0|672e811f582e2df5c328db14")).toBe(
      "auth0|672e811f582e2df5c328db14",
    );
    expect(validateJudgeSubject("google-oauth2|1092837465192837465")).toBe(
      "google-oauth2|1092837465192837465",
    );
    expect(validateJudgeSubject("  auth0|1234567890abcdef12345678  ")).toBe(
      "auth0|1234567890abcdef12345678",
    );
  });

  it("6. Provisions new judge user into judge tenant with strictly JUDGE role", async () => {
    const res = await provisionJudgeUser(testSubject, {
      db,
      nodeEnv: "development",
    });

    expect(res).toBeDefined();
    expect(res.tenantId).toBe(JUDGE_TENANT_ID);
    expect(res.role).toBe(ALLOWED_JUDGE_ROLE);
    expect(res.isNewUser).toBe(true);
    expect(res.isNewMembership).toBe(true);
    expect(typeof res.userId).toBe("string");
    expect(typeof res.membershipId).toBe("string");

    createdUserId = res.userId;

    // Verify user in app_users
    const userInDb = await db
      .selectFrom("app_users")
      .where("id", "=", res.userId)
      .selectAll()
      .executeTakeFirst();

    expect(userInDb).toBeDefined();
    expect(userInDb?.oidc_subject).toBe(testSubject);

    // Verify membership in judge tenant
    const { sql } = await import("kysely");
    const membershipInDb = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("id", "=", res.membershipId)
        .selectAll()
        .executeTakeFirst();
    });

    expect(membershipInDb).toBeDefined();
    expect(membershipInDb?.user_id).toBe(res.userId);
    expect(membershipInDb?.tenant_id).toBe(JUDGE_TENANT_ID);
    expect(membershipInDb?.role).toBe("JUDGE");
    expect(membershipInDb?.role_version).toBe(1);
    expect(membershipInDb?.revoked_at).toBeNull();
  });

  it("7. Updates existing judge user idempotently without duplicating records", async () => {
    const res2 = await provisionJudgeUser(testSubject, {
      db,
      nodeEnv: "development",
    });

    expect(res2.userId).toBe(createdUserId);
    expect(res2.isNewUser).toBe(false);
    expect(res2.isNewMembership).toBe(false);
    expect(res2.tenantId).toBe(JUDGE_TENANT_ID);
    expect(res2.role).toBe("JUDGE");
  });

  it("8. Strictly NEVER retains development tenant membership", async () => {
    // If an accidental dev tenant membership existed, provisionJudgeUser strips it
    const { sql } = await import("kysely");
    await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${DEV_TENANT_ID}, true)`.execute(trx);
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: createdUserId!,
          role: "BUYER",
          role_version: 1,
          revoked_at: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();
    });

    // Run provisioning again
    await provisionJudgeUser(testSubject, {
      db,
      nodeEnv: "development",
    });

    // Check dev membership was removed
    const devMem = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${DEV_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", createdUserId!)
        .where("tenant_id", "=", DEV_TENANT_ID)
        .selectAll()
        .executeTakeFirst();
    });

    expect(devMem).toBeUndefined();
  });
});
