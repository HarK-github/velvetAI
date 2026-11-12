import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { FastifyInstance } from "fastify";
import {
  createDatabaseClient,
  migrateToLatest,
  getTestDatabaseUrl,
  type Database,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";
import { resetPublicRateLimits } from "../plugins/public-rate-limit.js";
import { JUDGE_TENANT_ID, DEV_TENANT_ID } from "@velvetai/domain";
import { JudgeResetService } from "@velvetai/application";

describe("WP 04A: Public Read-Only Access (/v1/services & /v1/availability)", () => {
  let app: FastifyInstance;
  let testDb: Kysely<Database>;
  let judgeServiceId: string;
  let judgeLocationId: string;

  beforeAll(async () => {
    const databaseUrl = getTestDatabaseUrl();
    testDb = createDatabaseClient(databaseUrl);
    await migrateToLatest(testDb);

    // Seed judge tenant fixtures via JudgeResetService
    const resetService = new JudgeResetService(testDb);
    await resetService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: "01932b10-0000-7000-8000-000000000002",
    });

    // Seed dev tenant with distinctive service
    await testDb
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Dev Tenant Flagship",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Query judge service and location
    const judgeService = await testDb
      .selectFrom("services")
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .select(["id"])
      .executeTakeFirstOrThrow();
    judgeServiceId = judgeService.id;

    const judgeLocation = await testDb
      .selectFrom("locations")
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .where("name", "=", "SoHo Flagship")
      .select(["id"])
      .executeTakeFirstOrThrow();
    judgeLocationId = judgeLocation.id;

    // Use default adapter with dev tokens disabled so unauthenticated requests are strictly tested
    const adapter = new Auth0AuthenticationAdapter({
      issuer: "https://auth0.velvetai.test/",
      audience: "https://velvetai.example/api",
      db: testDb,
      allowDevTokens: false,
    });
    setAuthAdapter(adapter);

    app = await buildApp({ testDatabaseUrl: databaseUrl });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await testDb.destroy();
  });

  beforeEach(() => {
    resetPublicRateLimits();
    process.env.PUBLIC_DEMO_TENANT_ID = JUDGE_TENANT_ID;
  });

  it("1. GET /v1/services works without a token, returns judge demo catalog without PII", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.services)).toBe(true);

    const svc = body.services.find((s: { id: string }) => s.id === judgeServiceId);
    expect(svc).toBeDefined();
    expect(svc.versions[0].name).toBeDefined();
    expect(svc.versions[0].priceMinor).toBeDefined();
    // Confirm no PII fields
    expect((svc as any).email).toBeUndefined();
    expect((svc as any).phone).toBeUndefined();
  });

  it("2. GET /v1/services/:id works without a token for judge demo service", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/services/${judgeServiceId}`,
    });

    expect(res.statusCode).toBe(200);
    const service = res.json();
    expect(service.id).toBe(judgeServiceId);
    expect(service.versions.length).toBeGreaterThan(0);
  });

  it("3. GET /v1/availability works without a token, returns slot start/end and deposit preview without PII", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/availability?serviceId=${judgeServiceId}&locationId=${judgeLocationId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);

    const firstSlot = body.slots[0];
    expect(firstSlot.startsAt).toBeDefined();
    expect(firstSlot.endsAt).toBeDefined();
    expect(firstSlot.resourceId).toBeDefined();
    expect(firstSlot.depositPreview).toBeDefined();
    // No PII
    expect(firstSlot.customer).toBeUndefined();
    expect(firstSlot.buyerName).toBeUndefined();
  });

  it("4. Unauthenticated request rejecting tenant_id in query (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/services?tenant_id=${DEV_TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const problem = res.json();
    expect(problem.code).toBe("tenant_override_forbidden");
    expect(problem.detail).toMatch(/Tenant override is forbidden/);
  });

  it("5. Unauthenticated request rejecting x-tenant-id in headers (400 Bad Request)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: {
        "x-tenant-id": DEV_TENANT_ID,
      },
    });

    expect(res.statusCode).toBe(400);
    const problem = res.json();
    expect(problem.code).toBe("tenant_override_forbidden");
  });

  it("6. Unauthenticated requests are rate limited to 60/min per IP", async () => {
    const testIp = "203.0.113.88";

    // First 60 requests pass
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/services",
        headers: { "x-forwarded-for": testIp },
      });
      expect(res.statusCode).toBe(200);
    }

    // 61st request is rate limited
    const blockedRes = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: { "x-forwarded-for": testIp },
    });

    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.headers["retry-after"]).toBeDefined();
    const problem = blockedRes.json();
    expect(problem.code).toBe("rate_limit_exceeded");
  });

  it("7. Unauthenticated mutations are rejected with 401 Unauthorized", async () => {
    // Hold mutation without token
    const holdRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/hold",
      payload: {
        quoteId: crypto.randomUUID(),
      },
    });
    expect(holdRes.statusCode).toBe(401);

    // Judge reset without token
    const resetRes = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {
        tenantId: JUDGE_TENANT_ID,
      },
    });
    expect(resetRes.statusCode).toBe(401);
  });
});
