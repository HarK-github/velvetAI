import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { FastifyInstance } from "fastify";
import * as jose from "jose";
import crypto from "node:crypto";
import {
  createDatabaseClient,
  migrateToLatest,
  getTestDatabaseUrl,
  type Database,
} from "@velvetai/db";
import { Kysely, sql } from "kysely";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter, requireScopes } from "../plugins/auth.js";
import { resetJitRateLimits } from "@velvetai/application";
import { JUDGE_TENANT_ID, DEV_TENANT_ID } from "@velvetai/domain";

describe("WP 04A: JIT Buyer Self-Provisioning", () => {
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;
  let testDb: Kysely<Database>;
  const testIssuer = "https://auth0.velvetai.test/";
  const testAudience = "https://velvetai.example/api";

  beforeAll(async () => {
    keyPair = await jose.generateKeyPair("RS256");
    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);
    await migrateToLatest(testDb);

    // Ensure judge tenant exists
    await testDb
      .insertInto("tenants")
      .values({
        id: JUDGE_TENANT_ID,
        name: "Velvet Judge Demo Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Ensure dev tenant exists
    await testDb
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Velvet Flagship Manhattan",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    const localKeySet: jose.JWTVerifyGetKey = async () => keyPair.publicKey;
    const adapter = new Auth0AuthenticationAdapter({
      issuer: testIssuer,
      audience: testAudience,
      db: testDb,
      allowDevTokens: false,
      localKeySet,
    });
    setAuthAdapter(adapter);

    app = await buildApp({ testDatabaseUrl: databaseUrl });

    app.get("/v1/test/guarded-read", { preHandler: [requireScopes("booking:read")] }, async () => ({
      ok: true,
    }));
    app.get(
      "/v1/test/guarded-refund",
      { preHandler: [requireScopes("merchant:refund")] },
      async () => ({
        ok: true,
      }),
    );

    await app.ready();
  });

  afterAll(async () => {
    delete process.env.SELF_SIGNUP_ENABLED;
    delete process.env.SELF_SIGNUP_TENANT_ID;
    await app.close();
    await testDb.destroy();
  });

  beforeEach(() => {
    resetJitRateLimits();
    process.env.SELF_SIGNUP_ENABLED = "true";
    process.env.SELF_SIGNUP_TENANT_ID = JUDGE_TENANT_ID;
  });

  afterEach(() => {
    delete process.env.SELF_SIGNUP_ENABLED;
    delete process.env.SELF_SIGNUP_TENANT_ID;
  });

  async function createSignedToken(sub: string, extraClaims: Record<string, unknown> = {}) {
    return await new jose.SignJWT({
      sub,
      email: `${sub}@example.com`,
      email_verified: true,
      scope: "booking:read booking:quote booking:prepare booking:commit",
      ...extraClaims,
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(testIssuer)
      .setAudience(testAudience)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(keyPair.privateKey);
  }

  it("1. New verified user -> first protected request returns 200, creates one app_user + one BUYER membership in judge tenant", async () => {
    const oidcSub = `auth0|jit-user-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const token = await createSignedToken(oidcSub, { email_verified: true });

    // Call protected route (e.g., GET /v1/test/guarded-read which requires booking:read)
    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);

    // Verify exactly one app_user created
    const users = await testDb
      .selectFrom("app_users")
      .where("oidc_subject", "=", oidcSub)
      .selectAll()
      .execute();
    expect(users.length).toBe(1);
    const userId = users[0]!.id;

    // Verify exactly one BUYER membership in JUDGE_TENANT_ID
    const memberships = await testDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", userId)
        .selectAll()
        .execute();
    });

    expect(memberships.length).toBe(1);
    expect(memberships[0]!.tenant_id).toBe(JUDGE_TENANT_ID);
    expect(memberships[0]!.role).toBe("BUYER");
    expect(memberships[0]!.role_version).toBe(1);
    expect(memberships[0]!.revoked_at).toBeNull();

    // Verify audit event user.self_provisioned recorded
    const auditEvents = await testDb
      .selectFrom("audit_events")
      .where("action", "=", "user.self_provisioned")
      .where("actor_id", "=", userId)
      .selectAll()
      .execute();
    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0]!.tenant_id).toBe(JUDGE_TENANT_ID);
    expect(auditEvents[0]!.metadata_redacted).toMatchObject({
      email_verified: true,
      sub: oidcSub,
    });
  });

  it("2. Flag off (SELF_SIGNUP_ENABLED=false) -> 403 user_not_provisioned", async () => {
    process.env.SELF_SIGNUP_ENABLED = "false";
    const oidcSub = `auth0|flag-off-${Date.now()}`;
    const token = await createSignedToken(oidcSub);

    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const problem = res.json();
    expect(problem.code).toBe("user_not_provisioned");

    // Verify no user was created
    const user = await testDb
      .selectFrom("app_users")
      .where("oidc_subject", "=", oidcSub)
      .executeTakeFirst();
    expect(user).toBeUndefined();
  });

  it("3. M2M token (@clients) -> no JIT, existing 403 behavior", async () => {
    const m2mSub = `mock_client_id_12345@clients`;
    const token = await createSignedToken(m2mSub, { gty: "client-credentials" });

    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const problem = res.json();
    expect(problem.code).toBe("user_not_provisioned");

    // Verify no user was created
    const user = await testDb
      .selectFrom("app_users")
      .where("oidc_subject", "=", m2mSub)
      .executeTakeFirst();
    expect(user).toBeUndefined();
  });

  it("4. Two concurrent first requests -> exactly one user, one membership", async () => {
    const oidcSub = `auth0|concurrent-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const token = await createSignedToken(oidcSub);

    const [res1, res2] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/test/guarded-read",
        headers: { authorization: `Bearer ${token}` },
      }),
      app.inject({
        method: "GET",
        url: "/v1/test/guarded-read",
        headers: { authorization: `Bearer ${token}` },
      }),
    ]);

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const users = await testDb
      .selectFrom("app_users")
      .where("oidc_subject", "=", oidcSub)
      .selectAll()
      .execute();
    expect(users.length).toBe(1);

    const memberships = await testDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", users[0]!.id)
        .selectAll()
        .execute();
    });
    expect(memberships.length).toBe(1);
    expect(memberships[0]!.role).toBe("BUYER");
  });

  it("5. JIT user cannot call merchant/judge routes (403)", async () => {
    const oidcSub = `auth0|jit-buyer-${Date.now()}`;
    const token = await createSignedToken(oidcSub);

    // Call merchant-only guarded route (guarded-refund requires merchant:refund)
    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-refund",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const problem = res.json();
    expect(problem.code).toBe("insufficient_scope");

    // Call judge reset endpoint
    const judgeRes = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {
        tenantId: JUDGE_TENANT_ID,
      },
    });

    expect(judgeRes.statusCode).toBe(403);
  });

  it("6. JIT never creates a membership in the dev tenant when judge tenant exists", async () => {
    const oidcSub = `auth0|judge-only-${Date.now()}`;
    const token = await createSignedToken(oidcSub);

    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);

    const user = await testDb
      .selectFrom("app_users")
      .where("oidc_subject", "=", oidcSub)
      .select(["id"])
      .executeTakeFirstOrThrow();

    // Verify NO membership in DEV_TENANT_ID
    const devMemberships = await testDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${DEV_TENANT_ID}, true)`.execute(trx);
      return await trx
        .selectFrom("memberships")
        .where("user_id", "=", user.id)
        .where("tenant_id", "=", DEV_TENANT_ID)
        .selectAll()
        .execute();
    });

    expect(devMemberships.length).toBe(0);
  });

  it("7. Revoked membership is not re-created or un-revoked by JIT", async () => {
    const oidcSub = `auth0|revoked-${Date.now()}`;
    const userId = crypto.randomUUID();

    // Insert user and revoked membership ahead of time
    await testDb
      .insertInto("app_users")
      .values({
        id: userId,
        oidc_subject: oidcSub,
        email_ciphertext: "revoked@velvetai.example",
      })
      .execute();

    await testDb.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.tenant_id', ${JUDGE_TENANT_ID}, true)`.execute(trx);
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          user_id: userId,
          role: "BUYER",
          role_version: 1,
          revoked_at: new Date(),
        })
        .execute();
    });

    const token = await createSignedToken(oidcSub);

    const res = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const problem = res.json();
    expect(problem.code).toBe("membership_revoked");
  });

  it("8. Rate limit over threshold (30/hour per IP) returns 429", async () => {
    const testIp = "192.168.10.55";

    // Create 30 users successfully
    for (let i = 0; i < 30; i++) {
      const oidcSub = `auth0|ratelimit-${i}-${Date.now()}`;
      const token = await createSignedToken(oidcSub);
      const res = await app.inject({
        method: "GET",
        url: "/v1/test/guarded-read",
        headers: {
          authorization: `Bearer ${token}`,
          "x-forwarded-for": testIp,
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 31st user from same IP triggers 429
    const blockedSub = `auth0|ratelimit-blocked-${Date.now()}`;
    const blockedToken = await createSignedToken(blockedSub);
    const blockedRes = await app.inject({
      method: "GET",
      url: "/v1/test/guarded-read",
      headers: {
        authorization: `Bearer ${blockedToken}`,
        "x-forwarded-for": testIp,
      },
    });

    expect(blockedRes.statusCode).toBe(429);
    const problem = blockedRes.json();
    expect(problem.code).toBe("self_signup_rate_limited");
    expect(problem.detail).toMatch(/Too many accounts created recently/);
  });
});
