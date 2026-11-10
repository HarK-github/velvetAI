import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import * as jose from "jose";
import { FastifyInstance } from "fastify";
import { Kysely, sql } from "kysely";
import {
  createDatabaseClient,
  Database,
  getTestDatabaseUrl,
  withTenantTransaction,
} from "@velvetai/db";
import { JudgeResetService } from "@velvetai/application";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";
import {
  JUDGE_TENANT_ID,
  JudgeAbuseLabService,
  LiveScenarioDefinition,
  UnauthorizedTenantAccessError,
} from "../judge/abuse-lab-runner.js";

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";

describe("WP 07: Live Abuse Lab Runner & /v1/judge/abuse-lab API", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;
  const issuer = "https://auth0.velvetai.test/";
  const audience = "https://velvetai.example/api";

  const judgeUserId = crypto.randomUUID();
  const judgeSubject = `auth0|judge-abuse-${Date.now()}`;
  const buyerUserId = crypto.randomUUID();
  const buyerSubject = `auth0|buyer-nonjudge-${Date.now()}`;
  const m2mUserId = crypto.randomUUID();
  const m2mSubject = `abuse-m2m-${Date.now()}@clients`;
  const devUserId = crypto.randomUUID();
  const devSubject = `auth0|dev-nonjudge-${Date.now()}`;

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
    db = createDatabaseClient(getTestDatabaseUrl());
    keyPair = await jose.generateKeyPair("RS256");

    // Seed test principals
    await db
      .insertInto("app_users")
      .values([
        {
          id: judgeUserId,
          oidc_subject: judgeSubject,
          email_ciphertext: "judge-abuse@velvetai.local",
        },
        {
          id: buyerUserId,
          oidc_subject: buyerSubject,
          email_ciphertext: "buyer-nonjudge@velvetai.local",
        },
        {
          id: m2mUserId,
          oidc_subject: m2mSubject,
          email_ciphertext: "m2m-abuse@velvetai.local",
        },
        {
          id: devUserId,
          oidc_subject: devSubject,
          email_ciphertext: "dev-nonjudge@velvetai.local",
        },
      ])
      .execute();

    // Ensure judge tenant is seeded cleanly so live prepareBooking scenarios have active service + location
    const resetService = new JudgeResetService(db);
    await resetService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: judgeUserId,
      now: new Date(),
    });

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
    });

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: devUserId,
          role: "OWNER",
          role_version: 1,
          revoked_at: null,
        })
        .execute();
    });

    const adapter = new Auth0AuthenticationAdapter({
      issuer,
      audience,
      db,
      allowDevTokens: false,
      localKeySet: async () => keyPair.publicKey,
    });
    setAuthAdapter(adapter);

    app = buildApp({ db });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    try {
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx.deleteFrom("judge_abuse_runs").where("tenant_id", "=", JUDGE_TENANT_ID).execute();
        await trx
          .deleteFrom("judge_runs")
          .where("requested_by", "in", [judgeUserId, buyerUserId, m2mUserId])
          .execute();
        await trx
          .deleteFrom("idempotency_records")
          .where("actor_id", "in", [judgeUserId, buyerUserId, m2mUserId])
          .execute();
        await trx
          .deleteFrom("memberships")
          .where("user_id", "in", [judgeUserId, buyerUserId, m2mUserId])
          .execute();
      });
      await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        await trx.deleteFrom("memberships").where("user_id", "=", devUserId).execute();
      });
      await db
        .deleteFrom("app_users")
        .where("id", "in", [judgeUserId, buyerUserId, m2mUserId, devUserId])
        .execute();
    } finally {
      if (app) {
        await app.close();
      }
      if (db) {
        await db.destroy();
      }
    }
  });

  it("refuses non-judge tenant at service layer", async () => {
    const svc = new JudgeAbuseLabService(db, app);
    await expect(
      svc.startRun({
        tenantId: DEV_TENANT_ID,
        actor: {
          subject: devSubject,
          userId: devUserId as never,
          tenantId: DEV_TENANT_ID as never,
          roles: ["OWNER"],
        },
      }),
    ).rejects.toThrow(UnauthorizedTenantAccessError);

    await expect(svc.listRuns(DEV_TENANT_ID)).rejects.toThrow(UnauthorizedTenantAccessError);
  });

  it("enforces fail-closed auth & tenant boundaries on /v1/judge/abuse-lab/runs", async () => {
    // 1. Unauthenticated -> 401
    const unauthRes = await app.inject({
      method: "GET",
      url: "/v1/judge/abuse-lab/runs",
    });
    expect(unauthRes.statusCode).toBe(401);

    // 2. Human BUYER lacking judge:abuse_lab -> 403 insufficient_scope
    const buyerJwt = await signJwt(buyerSubject, { scope: "booking:read" });
    const buyerRes = await app.inject({
      method: "GET",
      url: "/v1/judge/abuse-lab/runs",
      headers: { authorization: `Bearer ${buyerJwt}` },
    });
    expect(buyerRes.statusCode).toBe(403);
    expect(JSON.parse(buyerRes.body).code).toBe("insufficient_scope");

    // 3. M2M @clients principal even with judge:abuse_lab scope -> 403 HUMAN_JUDGE_REQUIRED
    const m2mJwt = await signJwt(m2mSubject, {
      scope: "judge:abuse_lab booking:read",
      gty: "client-credentials",
    });
    const m2mRes = await app.inject({
      method: "POST",
      url: "/v1/judge/abuse-lab/runs",
      headers: {
        authorization: `Bearer ${m2mJwt}`,
        "idempotency-key": `m2m-deny-${Date.now()}`,
      },
      payload: {},
    });
    expect(m2mRes.statusCode).toBe(403);
    expect(JSON.parse(m2mRes.body).code).toBe("HUMAN_JUDGE_REQUIRED");

    // 4. Dev tenant OWNER -> 403 (lacks judge:abuse_lab or non-judge tenant)
    const devJwt = await signJwt(devSubject, { scope: "booking:read judge:abuse_lab" });
    const devRes = await app.inject({
      method: "GET",
      url: "/v1/judge/abuse-lab/runs",
      headers: { authorization: `Bearer ${devJwt}` },
    });
    expect(devRes.statusCode).toBe(403);
  });

  it("requires Idempotency-Key on POST /v1/judge/abuse-lab/runs (400 idempotency_key_required)", async () => {
    const judgeJwt = await signJwt(judgeSubject, {
      scope: "openid profile email booking:read",
    });

    const missingKeyRes = await app.inject({
      method: "POST",
      url: "/v1/judge/abuse-lab/runs",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(missingKeyRes.statusCode).toBe(400);
    expect(JSON.parse(missingKeyRes.body).code).toBe("idempotency_key_required");
  });

  it("runs all 10 live scenarios (L1, L4-L12) with zero net judge state changes, enforces 30s rate limit, and supports polling", async () => {
    // JWT intentionally omits judge:* claims to exercise Auth0 human JUDGE scope union
    const judgeJwt = await signJwt(judgeSubject, {
      scope: "openid profile email booking:read booking:prepare booking:commit booking:cancel",
    });

    const listBefore = await app.inject({
      method: "GET",
      url: "/v1/judge/abuse-lab/runs",
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(listBefore.statusCode).toBe(200);
    expect(JSON.parse(listBefore.body)).toMatchObject({
      isJudge: true,
      tenantId: JUDGE_TENANT_ID,
    });

    const idempKey = `live-run-${Date.now()}`;
    const triggerRes = await app.inject({
      method: "POST",
      url: "/v1/judge/abuse-lab/runs",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": idempKey,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(triggerRes.statusCode).toBe(202);
    const triggerBody = JSON.parse(triggerRes.body) as {
      runId: string;
      status: string;
      statusUrl: string;
    };
    expect(triggerBody.status).toBe("RUNNING");
    expect(triggerBody.statusUrl).toBe(`/v1/judge/abuse-lab/runs/${triggerBody.runId}`);

    // Replaying identical Idempotency-Key returns cached 202 without rate-limit collision
    const replayRes = await app.inject({
      method: "POST",
      url: "/v1/judge/abuse-lab/runs",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": idempKey,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(replayRes.statusCode).toBe(202);
    expect(JSON.parse(replayRes.body).runId).toBe(triggerBody.runId);

    // New Idempotency-Key inside 30s rate limit window returns 429 with Retry-After
    const rateLimitedRes = await app.inject({
      method: "POST",
      url: "/v1/judge/abuse-lab/runs",
      headers: {
        authorization: `Bearer ${judgeJwt}`,
        "idempotency-key": `live-run-rate-${Date.now()}`,
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(rateLimitedRes.statusCode).toBe(429);
    expect(Number(rateLimitedRes.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(rateLimitedRes.body).code).toBe("rate_limit_exceeded");

    // Poll until background run completes
    let finalRun: {
      runId: string;
      status: string;
      finishedAt: string | null;
      scenarios: Array<{
        id: string;
        status: string;
        stateUnchanged: boolean | null;
        beforeCounts?: Record<string, number>;
        afterCounts?: Record<string, number>;
      }>;
      summary: {
        total: number;
        passed: number;
        failed: number;
        errored: number;
        allStateUnchanged: boolean;
      } | null;
    } | null = null;

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const pollRes = await app.inject({
        method: "GET",
        url: triggerBody.statusUrl,
        headers: { authorization: `Bearer ${judgeJwt}` },
      });
      expect(pollRes.statusCode).toBe(200);
      const parsed = JSON.parse(pollRes.body);
      if (parsed.status !== "RUNNING") {
        finalRun = parsed;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(finalRun).not.toBeNull();
    expect(finalRun!.status).toBe("SUCCEEDED");
    expect(finalRun!.finishedAt).not.toBeNull();
    expect(finalRun!.summary).toEqual({
      total: 10,
      passed: 10,
      failed: 0,
      errored: 0,
      allStateUnchanged: true,
    });

    const ids = finalRun!.scenarios.map((s) => s.id);
    expect(ids).toEqual(["L1", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12"]);
    for (const s of finalRun!.scenarios) {
      expect(s.status).toBe("PASS");
      expect(s.stateUnchanged).toBe(true);
      expect(s.afterCounts).toEqual(s.beforeCounts);
    }

    // Invalid/missing run ID error handling
    const badIdRes = await app.inject({
      method: "GET",
      url: "/v1/judge/abuse-lab/runs/not-a-uuid",
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(badIdRes.statusCode).toBe(400);

    const notFoundRes = await app.inject({
      method: "GET",
      url: `/v1/judge/abuse-lab/runs/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(notFoundRes.statusCode).toBe(404);
  }, 30_000);

  it("marks timed-out slow scenarios as ERROR while still running remaining scenarios and keeping runs pruned to 50", async () => {
    const customScenarios: LiveScenarioDefinition[] = [
      {
        id: "L-SLOW",
        name: "Injected hung scenario",
        level: "Service",
        ciScenarioId: "SEC-001",
        expected: "Timeout ERROR",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { passed: true, observed: "Finished too late" };
        },
      },
      {
        id: "L-FAST",
        name: "Subsequent fast scenario",
        level: "Service",
        ciScenarioId: "SEC-002",
        expected: "PASS after timeout",
        execute: async () => ({ passed: true, observed: "Executed cleanly" }),
      },
    ];

    // Seed 50 existing runs so adding 1 more prunes the oldest back down to 50
    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      await trx.deleteFrom("judge_abuse_runs").where("tenant_id", "=", JUDGE_TENANT_ID).execute();
      const baseMs = Date.UTC(2026, 10, 1, 0, 0, 0);
      await trx
        .insertInto("judge_abuse_runs")
        .values(
          Array.from({ length: 50 }, (_, idx) => ({
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            status: "SUCCEEDED",
            started_at: new Date(baseMs + idx * 1000),
            finished_at: new Date(baseMs + idx * 1000 + 500),
            requested_by: judgeSubject,
            scenarios: JSON.stringify([]),
            summary: JSON.stringify({
              total: 0,
              passed: 0,
              failed: 0,
              errored: 0,
              allStateUnchanged: true,
            }),
          })),
        )
        .execute();
    });

    const boundedService = new JudgeAbuseLabService(db, app, {
      scenarios: customScenarios,
      scenarioTimeoutMs: 40,
      totalBudgetMs: 5_000,
      rateLimitWindowMs: 0,
    });

    const started = await boundedService.startRun({
      tenantId: JUDGE_TENANT_ID,
      actor: {
        subject: judgeSubject,
        userId: judgeUserId as never,
        tenantId: JUDGE_TENANT_ID as never,
        roles: ["JUDGE", "BUYER", "SCHEDULER"],
      },
    });

    const finished = await boundedService.waitForRun(started.runId);
    expect(finished).not.toBeNull();
    expect(finished!.status).toBe("FAILED");
    expect(finished!.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      errored: 1,
      allStateUnchanged: true,
    });
    expect(finished!.scenarios[0]!.status).toBe("ERROR");
    expect(finished!.scenarios[0]!.observed).toContain("exceeded 40ms timeout");
    expect(finished!.scenarios[1]!.status).toBe("PASS");
    expect(finished!.scenarios[1]!.stateUnchanged).toBe(true);

    const rowCount = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      const res = await sql<{ cnt: number }>`
        SELECT COUNT(*)::int AS cnt FROM judge_abuse_runs WHERE tenant_id = ${JUDGE_TENANT_ID}::uuid
      `.execute(trx);
      return Number(res.rows[0]?.cnt ?? 0);
    });
    expect(rowCount).toBe(50);

    // Wait briefly so the slow timer callback settles cleanly before test teardown
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
});
