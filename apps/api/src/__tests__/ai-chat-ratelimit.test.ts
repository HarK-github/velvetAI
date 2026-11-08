import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import {
  createDatabaseClient,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { FakeModelProvider } from "@velvetai/application";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";
import { resetAiRateLimitsForTesting } from "../routes/ai.js";

describe("Gemini Protection: Per-User, Per-IP, and Global Daily Rate Limits", () => {
  let app: FastifyInstance;
  let testDb: Kysely<Database>;
  let simulatedTime = 1_700_000_000_000; // deterministic epoch
  const fakeClock = () => simulatedTime;

  const tenantId = "01932b10-0000-7000-8000-000000000001";
  const user1Id = "01932b10-0000-7000-8000-000000000011";
  const user2Id = "01932b10-0000-7000-8000-000000000012";

  const user1Auth = `Bearer test-token:${user1Id}:${tenantId}:BUYER:1`;
  const user2Auth = `Bearer test-token:${user2Id}:${tenantId}:BUYER:1`;

  const fakeProvider = new FakeModelProvider();

  beforeAll(async () => {
    process.env.OIDC_MOCK_ENABLED = "true";
    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);
    setAuthAdapter(new Auth0AuthenticationAdapter({ db: testDb, allowDevTokens: true }));

    // Seed test tenant & users
    await testDb
      .insertInto("tenants")
      .values({
        id: tenantId,
        name: "Rate Limit Test Tenant",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    for (const uid of [user1Id, user2Id]) {
      await testDb
        .insertInto("app_users")
        .values({
          id: uid,
          oidc_subject: `oidc|ai-limit-${uid}`,
          email_ciphertext: `ai-${uid}@velvetai.internal`,
        })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();

      await withTenantTransaction(testDb, tenantId, async (trx) => {
        await trx
          .insertInto("memberships")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            user_id: uid,
            role: "BUYER",
            role_version: 1,
          })
          .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
          .execute();
      });
    }

    app = buildApp({
      db: testDb,
      modelProvider: fakeProvider,
      clock: fakeClock,
      dailyTurnBudget: 50, // configured daily budget for testing
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await testDb.destroy();
  });

  beforeEach(() => {
    resetAiRateLimitsForTesting();
    simulatedTime = 1_700_000_000_000;
  });

  it("enforces per-user limit: 10 turns per 10 minutes", async () => {
    // 10 turns succeed for user 1
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ai/chat",
        headers: {
          authorization: user1Auth,
          "content-type": "application/json",
          "x-forwarded-for": `10.0.0.${i + 1}`, // different IPs so IP limit does not trigger
        },
        payload: {
          messages: [{ role: "user", content: `Turn ${i + 1}` }],
        },
      });
      expect(res.statusCode).toBe(200);
      simulatedTime += 1000; // 1 second between turns
    }

    // Turn 11 within the 10-minute window should be rejected with 429 ai_quota_exceeded
    const res11 = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: user1Auth,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.99",
      },
      payload: {
        messages: [{ role: "user", content: "Turn 11 (should fail)" }],
      },
    });

    expect(res11.statusCode).toBe(429);
    expect(res11.headers["retry-after"]).toBeDefined();
    const body = JSON.parse(res11.body);
    expect(body.code).toBe("ai_quota_exceeded");
    expect(body.error).toBe("ai_quota_exceeded");
    expect(body.message).toContain("10 turns per 10 minutes");

    // User 2 should NOT be blocked (per-user isolation)
    const resUser2 = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: user2Auth,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.100",
      },
      payload: {
        messages: [{ role: "user", content: "User 2 turn" }],
      },
    });
    expect(resUser2.statusCode).toBe(200);

    // Fast-forward simulated clock past 10 minutes (601 seconds)
    simulatedTime += 601_000;

    // User 1 can now send requests again
    const resAfterExpiry = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: user1Auth,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.101",
      },
      payload: {
        messages: [{ role: "user", content: "User 1 after window reset" }],
      },
    });
    expect(resAfterExpiry.statusCode).toBe(200);
  });

  it("enforces per-IP limit: 30 turns per 10 minutes", async () => {
    const sharedIp = "192.168.1.100";

    // Perform 30 turns from the same IP using alternating user identities
    for (let i = 0; i < 30; i++) {
      // Rotate between users to ensure per-user limit (10) isn't hit
      // We can use unique dev-tokens or rotate users
      const uid = `user-ip-test-${Math.floor(i / 8)}`;
      const auth = `Bearer test-token:${uid}:${tenantId}:BUYER:1`;

      const res = await app.inject({
        method: "POST",
        url: "/v1/ai/chat",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "x-forwarded-for": sharedIp,
        },
        payload: {
          messages: [{ role: "user", content: `IP turn ${i + 1}` }],
        },
      });
      expect(res.statusCode).toBe(200);
      simulatedTime += 1000;
    }

    // 31st turn from the same IP should fail
    const res31 = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:user-brand-new:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": sharedIp,
      },
      payload: {
        messages: [{ role: "user", content: "IP turn 31 (should fail)" }],
      },
    });

    expect(res31.statusCode).toBe(429);
    expect(res31.headers["retry-after"]).toBeDefined();
    const body = JSON.parse(res31.body);
    expect(body.code).toBe("ai_quota_exceeded");
    expect(body.message).toContain("30 turns per 10 minutes");

    // A different IP should NOT be blocked
    const resOtherIp = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:user-brand-new:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": "192.168.1.200",
      },
      payload: {
        messages: [{ role: "user", content: "Different IP turn" }],
      },
    });
    expect(resOtherIp.statusCode).toBe(200);
  });

  it("enforces global daily turn budget", async () => {
    // Create an app instance with a small daily budget of 5 turns
    const budgetApp = buildApp({
      db: testDb,
      modelProvider: fakeProvider,
      clock: fakeClock,
      dailyTurnBudget: 5,
    });
    await budgetApp.ready();

    for (let i = 0; i < 5; i++) {
      const res = await budgetApp.inject({
        method: "POST",
        url: "/v1/ai/chat",
        headers: {
          authorization: `Bearer test-token:budget-user-${i}:${tenantId}:BUYER:1`,
          "content-type": "application/json",
          "x-forwarded-for": `172.16.0.${i + 1}`,
        },
        payload: {
          messages: [{ role: "user", content: `Budget turn ${i + 1}` }],
        },
      });
      expect(res.statusCode).toBe(200);
      simulatedTime += 1000;
    }

    // 6th turn exceeds global daily budget
    const resOverBudget = await budgetApp.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:budget-user-fresh:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": "172.16.0.99",
      },
      payload: {
        messages: [{ role: "user", content: "Turn exceeding daily budget" }],
      },
    });

    expect(resOverBudget.statusCode).toBe(429);
    const body = JSON.parse(resOverBudget.body);
    expect(body.code).toBe("ai_quota_exceeded");
    expect(body.message).toContain("AI daily turn budget reached");

    // Advance clock past 24 hours
    simulatedTime += 24 * 60 * 60 * 1000 + 1000;

    const resNextDay = await budgetApp.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:budget-user-fresh:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": "172.16.0.99",
      },
      payload: {
        messages: [{ role: "user", content: "Turn on next day" }],
      },
    });
    expect(resNextDay.statusCode).toBe(200);

    await budgetApp.close();
  });

  it("assigns separate IP rate limit buckets to different X-Forwarded-For headers", async () => {
    const ipA = "203.0.113.10";
    const ipB = "198.51.100.20";

    // Exhaust ipA (30 turns with unique users)
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ai/chat",
        headers: {
          authorization: `Bearer test-token:ipa-user-${i}:${tenantId}:BUYER:1`,
          "content-type": "application/json",
          "x-forwarded-for": ipA,
        },
        payload: {
          messages: [{ role: "user", content: `Turn for IP A ${i}` }],
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 31st turn for ipA should be rate limited
    const resIpABlocked = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:ipa-user-overflow:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": ipA,
      },
      payload: {
        messages: [{ role: "user", content: "Exceeded turn for IP A" }],
      },
    });
    expect(resIpABlocked.statusCode).toBe(429);
    expect(JSON.parse(resIpABlocked.body).message).toContain("30 turns per 10 minutes");

    // ipB has a separate bucket and must still succeed
    const resIpBOk = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: `Bearer test-token:ipb-user-1:${tenantId}:BUYER:1`,
        "content-type": "application/json",
        "x-forwarded-for": ipB,
      },
      payload: {
        messages: [{ role: "user", content: "First turn for IP B" }],
      },
    });
    expect(resIpBOk.statusCode).toBe(200);
  });

  it("prevents spoofed X-Forwarded-For headers from bypassing the per-user turn limit", async () => {
    // User 1 attempts to bypass their 10-turn limit by spoofing a different IP on every turn
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/ai/chat",
        headers: {
          authorization: user1Auth,
          "content-type": "application/json",
          "x-forwarded-for": `10.200.${i}.1`, // Spoofing IP on every request
        },
        payload: {
          messages: [{ role: "user", content: `User 1 attempt with spoofed IP ${i}` }],
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 11th turn with yet another fresh spoofed IP
    const resSpoofed11 = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: user1Auth,
        "content-type": "application/json",
        "x-forwarded-for": "10.200.99.1", // Fresh spoofed IP
      },
      payload: {
        messages: [{ role: "user", content: "Turn 11 trying to bypass per-user limit" }],
      },
    });

    // Still blocked! Per-user quota binds to the authenticated user ID, not the IP
    expect(resSpoofed11.statusCode).toBe(429);
    const body = JSON.parse(resSpoofed11.body);
    expect(body.code).toBe("ai_quota_exceeded");
    expect(body.message).toContain("10 turns per 10 minutes");
  });
});
