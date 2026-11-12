import crypto from "node:crypto";
import * as jose from "jose";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { Kysely } from "kysely";
import {
  createDatabaseClient,
  Database,
  getTestDatabaseUrl,
  migrateToLatest,
  withTenantTransaction,
} from "@velvetai/db";
import { DEV_TENANT_ID, JUDGE_TENANT_ID } from "@velvetai/domain";
import { JudgeRaceTestService, JudgeResetService } from "@velvetai/application";
import { UserId } from "@velvetai/contracts";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";

describe("WP 05 Step 4: POST /v1/judge/race-test", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;

  const issuer = "https://auth0.velvetai.test/";
  const audience = "https://velvetai.example/api";

  const judgeUserId = crypto.randomUUID() as UserId;
  const judgeSub = `auth0|race-judge-${Date.now()}`;
  const buyerUserId = crypto.randomUUID() as UserId;
  const buyerSub = `auth0|race-buyer-${Date.now()}`;
  const m2mUserId = crypto.randomUUID() as UserId;
  const m2mSub = `race-m2m-${Date.now()}@clients`;
  const devOwnerUserId = crypto.randomUUID() as UserId;
  const devOwnerSub = `auth0|race-devowner-${Date.now()}`;

  let judgeServiceId: string;
  let judgeResourceId: string;

  async function signJwt(sub: string, extraClaims: Record<string, unknown> = {}): Promise<string> {
    return new jose.SignJWT({ sub, ...extraClaims })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(keyPair.privateKey);
  }

  beforeAll(async () => {
    db = createDatabaseClient(getTestDatabaseUrl(), { min: 2, max: 15 });
    await migrateToLatest(db);
    keyPair = await jose.generateKeyPair("RS256");

    const existingSystemJudge = await db
      .selectFrom("app_users")
      .where("oidc_subject", "=", "auth0|system-judge")
      .select(["id"])
      .executeTakeFirst();

    await new JudgeResetService(db).resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: existingSystemJudge?.id ?? "01932b10-0000-7000-8000-000000000002",
    });

    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Dev Tenant For Race Security",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await db
      .insertInto("app_users")
      .values([
        { id: judgeUserId, oidc_subject: judgeSub, email_ciphertext: "race-judge@velvetai.local" },
        { id: buyerUserId, oidc_subject: buyerSub, email_ciphertext: "race-buyer@velvetai.local" },
        { id: m2mUserId, oidc_subject: m2mSub, email_ciphertext: "race-m2m@velvetai.local" },
        {
          id: devOwnerUserId,
          oidc_subject: devOwnerSub,
          email_ciphertext: "race-dev@velvetai.local",
        },
      ])
      .execute();

    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      await trx
        .insertInto("memberships")
        .values([
          {
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            user_id: judgeUserId,
            role: "JUDGE",
            role_version: 1,
            revoked_at: null,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            user_id: buyerUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            user_id: m2mUserId,
            role: "JUDGE",
            role_version: 1,
            revoked_at: null,
          },
        ])
        .execute();

      const svc = await trx
        .selectFrom("services")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("status", "=", "ACTIVE")
        .select(["id"])
        .executeTakeFirstOrThrow();
      const res = await trx
        .selectFrom("resources")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("status", "=", "ACTIVE")
        .select(["id"])
        .executeTakeFirstOrThrow();
      judgeServiceId = svc.id;
      judgeResourceId = res.id;
    });

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: devOwnerUserId,
          role: "JUDGE",
          role_version: 1,
          revoked_at: null,
        })
        .execute();
    });

    setAuthAdapter(
      new Auth0AuthenticationAdapter({
        issuer,
        audience,
        db,
        allowDevTokens: false,
        localKeySet: async () => keyPair.publicKey,
      }),
    );

    app = buildApp({ db });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    try {
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx
          .deleteFrom("memberships")
          .where("user_id", "in", [judgeUserId, buyerUserId, m2mUserId])
          .execute();
      });
      await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        await trx.deleteFrom("memberships").where("user_id", "=", devOwnerUserId).execute();
      });
      await db
        .deleteFrom("app_users")
        .where("id", "in", [judgeUserId, buyerUserId, m2mUserId, devOwnerUserId])
        .execute();
    } finally {
      if (app) await app.close();
      if (db) await db.destroy();
    }
  });

  it("enforces fail-closed auth, M2M rejection, non-judge tenant 403, Idempotency-Key, and 30s rate limit", async () => {
    // 1. Unauthenticated -> 401
    const unauth = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: { "idempotency-key": `race-unauth-${Date.now()}` },
      payload: {},
    });
    expect(unauth.statusCode).toBe(401);

    const judgeJwt = await signJwt(judgeSub, {
      scope: "booking:read booking:prepare booking:commit booking:cancel",
      "https://velvetai.com/role_version": 1,
    });

    // 2. Missing Idempotency-Key -> 400 idempotency_key_required
    const missingKey = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: { authorization: `Bearer ${judgeJwt}` },
      payload: {},
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().code).toBe("idempotency_key_required");

    // 3. M2M token -> 403 HUMAN_JUDGE_REQUIRED
    const m2mJwt = await signJwt(m2mSub, {
      gty: "client-credentials",
      scope: "judge:abuse_lab",
      "https://velvetai.com/role_version": 1,
    });
    const m2mRes = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${m2mJwt}`,
        "idempotency-key": `race-m2m-${Date.now()}`,
      },
      payload: {},
    });
    expect(m2mRes.statusCode).toBe(403);
    expect(m2mRes.json().code).toBe("HUMAN_JUDGE_REQUIRED");

    // 4. BUYER token -> 403 insufficient_scope
    const buyerJwt = await signJwt(buyerSub, {
      scope: "booking:prepare booking:commit",
      "https://velvetai.com/role_version": 1,
    });
    const buyerRes = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${buyerJwt}`,
        "idempotency-key": `race-buyer-${Date.now()}`,
      },
      payload: {},
    });
    expect(buyerRes.statusCode).toBe(403);

    // 5. Dev tenant owner claiming judge:abuse_lab -> 403 UNAUTHORIZED_TENANT_ACCESS
    const devJwt = await signJwt(devOwnerSub, {
      scope: "judge:abuse_lab",
      "https://velvetai.com/role_version": 1,
    });
    const devRes = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${devJwt}`,
        "idempotency-key": `race-dev-${Date.now()}`,
      },
      payload: {},
    });
    expect(devRes.statusCode).toBe(403);
    expect(devRes.json().code).toBe("UNAUTHORIZED_TENANT_ACCESS");

    // 6. Parallel bounds (<2 or >50) -> 400
    const badBounds = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": `race-bounds-${Date.now()}`,
      },
      payload: { parallel: 1 },
    });
    expect(badBounds.statusCode).toBe(400);

    // 7. Valid 20-parallel run -> 200 with 1 winner / 19 conflicts
    const startsAt = new Date(Date.now() + 12 * 86_400_000);
    startsAt.setUTCHours(14, 0, 0, 0);
    const idempKey = `race-ok-${Date.now()}`;

    const okRes = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": idempKey,
      },
      payload: {
        resourceId: judgeResourceId,
        serviceId: judgeServiceId,
        startsAt: startsAt.toISOString(),
        parallel: 20,
      },
    });
    expect(okRes.statusCode).toBe(200);
    const body = okRes.json();
    expect(body.attempts).toBe(20);
    expect(body.succeeded).toBe(1);
    expect(body.conflicts).toBe(19);
    expect(body.winnerHoldId).toMatch(/^hold_/);

    // Same Idempotency-Key replays cached 200 cleanly
    const replayRes = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": idempKey,
      },
      payload: {
        resourceId: judgeResourceId,
        serviceId: judgeServiceId,
        startsAt: startsAt.toISOString(),
        parallel: 20,
      },
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.headers["x-idempotent-replay"]).toBe("true");

    // Different Idempotency-Key inside 30s -> 429 Retry-After
    const rateLimited = await app.inject({
      method: "POST",
      url: "/v1/judge/race-test",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": `race-second-${Date.now()}`,
      },
      payload: {
        resourceId: judgeResourceId,
        serviceId: judgeServiceId,
        startsAt: startsAt.toISOString(),
        parallel: 20,
      },
    });
    expect(rateLimited.statusCode).toBe(429);
    expect(Number(rateLimited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("handles parallel=50 via HTTP cleanly without rate-limit mock", async () => {
    const unlimitedApp = buildApp({
      db,
      raceTestService: new JudgeRaceTestService(db, { rateLimitWindowMs: 0 }),
    });
    await unlimitedApp.ready();

    try {
      const judgeJwt = await signJwt(judgeSub, {
        scope: "judge:abuse_lab",
        "https://velvetai.com/role_version": 1,
      });
      const startsAt = new Date(Date.now() + 13 * 86_400_000);
      startsAt.setUTCHours(16, 0, 0, 0);

      const res = await unlimitedApp.inject({
        method: "POST",
        url: "/v1/judge/race-test",
        headers: {
          authorization: `Bearer ${judgeJwt}`,
          "idempotency-key": `race-50-${Date.now()}`,
        },
        payload: {
          resourceId: judgeResourceId,
          serviceId: judgeServiceId,
          startsAt: startsAt.toISOString(),
          parallel: 50,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.attempts).toBe(50);
      expect(body.succeeded).toBe(1);
      expect(body.conflicts).toBe(49);
    } finally {
      await unlimitedApp.close();
    }
  }, 30_000);
});
