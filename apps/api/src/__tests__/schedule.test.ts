import crypto from "node:crypto";
import * as jose from "jose";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { BookingService, JudgeResetService } from "@velvetai/application";
import {
  IanaTimeZone,
  LocationId,
  Rfc3339Timestamp,
  ServiceId,
  UserId,
  scheduleResponseSchema,
} from "@velvetai/contracts";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";
import { resetPublicRateLimits } from "../plugins/public-rate-limit.js";

describe("WP 05 & 04A Part 4: GET /v1/merchant/schedule", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;

  const issuer = "https://auth0.velvetai.test/";
  const audience = "https://velvetai.example/api";

  const judgeUserId = crypto.randomUUID() as UserId;
  const judgeSub = `auth0|sched-judge-${Date.now()}`;
  const buyerUserId = crypto.randomUUID() as UserId;
  const buyerSub = `auth0|sched-buyer-${Date.now()}`;
  const devOwnerUserId = crypto.randomUUID() as UserId;
  const devOwnerSub = `auth0|sched-dev-owner-${Date.now()}`;

  const devLocationId = "01932b10-0002-7000-8000-000000000099" as LocationId;
  const devServiceId = "01932b10-0001-7000-8000-000000000099" as ServiceId;
  const devServiceVerId = "01932b10-0002-7000-8000-000000000199";
  const devResourceId = "01932b10-0004-7000-8000-000000000099";

  let judgeServiceId: ServiceId;
  let judgeLocationId: LocationId;

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
    db = createDatabaseClient(getTestDatabaseUrl(), { min: 2, max: 12 });
    await migrateToLatest(db);
    keyPair = await jose.generateKeyPair("RS256");

    const existingSystemJudge = await db
      .selectFrom("app_users")
      .where("oidc_subject", "=", "auth0|system-judge")
      .select(["id"])
      .executeTakeFirst();

    const resetService = new JudgeResetService(db);
    await resetService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: existingSystemJudge?.id ?? "01932b10-0000-7000-8000-000000000002",
    });

    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Dev Cross-Tenant Check",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await db
      .insertInto("app_users")
      .values([
        { id: judgeUserId, oidc_subject: judgeSub, email_ciphertext: "judge-sched@velvetai.local" },
        { id: buyerUserId, oidc_subject: buyerSub, email_ciphertext: "buyer-sched@velvetai.local" },
        {
          id: devOwnerUserId,
          oidc_subject: devOwnerSub,
          email_ciphertext: "devowner-sched@velvetai.local",
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
        .select(["location_id"])
        .executeTakeFirstOrThrow();
      judgeServiceId = svc.id as ServiceId;
      judgeLocationId = res.location_id as LocationId;
    });

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: devOwnerUserId,
          role: "OWNER",
          role_version: 1,
          revoked_at: null,
        })
        .execute();

      await trx
        .insertInto("locations")
        .values({
          id: devLocationId,
          tenant_id: DEV_TENANT_ID,
          name: "Dev Isolated Location",
          timezone: "America/Los_Angeles",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: devServiceId,
          tenant_id: DEV_TENANT_ID,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: devServiceVerId,
          tenant_id: DEV_TENANT_ID,
          service_id: devServiceId,
          version: 1,
          name: "Dev Secret Service",
          duration_minutes: 60,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "9900",
          base_deposit_minor: "3000",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: devServiceVerId })
        .where("id", "=", devServiceId)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: devResourceId,
          tenant_id: DEV_TENANT_ID,
          location_id: devLocationId,
          resource_type: "STAFF",
          display_name: "Dev-Only Provider",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
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
          .where("user_id", "in", [judgeUserId, buyerUserId])
          .execute();
      });
      await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        await trx.deleteFrom("memberships").where("user_id", "=", devOwnerUserId).execute();
      });
      await db
        .deleteFrom("app_users")
        .where("id", "in", [judgeUserId, buyerUserId, devOwnerUserId])
        .execute();
    } finally {
      if (app) await app.close();
      if (db) await db.destroy();
    }
  });

  beforeEach(() => {
    resetPublicRateLimits();
    process.env.PUBLIC_DEMO_TENANT_ID = JUDGE_TENANT_ID;
  });

  it("enforces scope, >14d range 400, ETag 304, cross-tenant isolation, and zero PII for authenticated callers", async () => {
    const bookingService = new BookingService(db);
    const judgeHoldStart = new Date(Date.now() + 10 * 86_400_000);
    judgeHoldStart.setUTCHours(15, 0, 0, 0);
    const devHoldStart = new Date(Date.now() + 10 * 86_400_000);
    devHoldStart.setUTCHours(18, 0, 0, 0);

    const judgeHold = await bookingService.prepareBooking(
      JUDGE_TENANT_ID,
      { subject: judgeSub, userId: judgeUserId, tenantId: JUDGE_TENANT_ID, roles: ["JUDGE"] },
      "ask-ai",
      {
        serviceId: judgeServiceId,
        locationId: judgeLocationId,
        startsAt: judgeHoldStart.toISOString() as Rfc3339Timestamp,
        timeZone: "America/New_York" as IanaTimeZone,
        customer: { email: "judge.pii.secret@example.com", displayName: "Elena Vance" },
        note: "PRIVATE CUSTOMER NOTE SHOULD NEVER LEAK",
      },
    );

    const devHold = await bookingService.prepareBooking(
      DEV_TENANT_ID,
      { subject: devOwnerSub, userId: devOwnerUserId, tenantId: DEV_TENANT_ID, roles: ["OWNER"] },
      "web",
      {
        serviceId: devServiceId,
        locationId: devLocationId,
        startsAt: devHoldStart.toISOString() as Rfc3339Timestamp,
        timeZone: "America/Los_Angeles" as IanaTimeZone,
        customer: { email: "dev.secret@example.com", displayName: "Dev Customer" },
        note: "DEV NOTE",
      },
    );

    try {
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 12 * 86_400_000).toISOString();

      // 1. Buyer lacking merchant:schedule / judge scope gets 403
      const buyerJwt = await signJwt(buyerSub, {
        scope: "booking:read booking:prepare",
        "https://velvetai.com/role_version": 1,
      });
      const buyerRes = await app.inject({
        method: "GET",
        url: `/v1/merchant/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { authorization: `Bearer ${buyerJwt}` },
      });
      expect(buyerRes.statusCode).toBe(403);

      // 2. Judge succeeds (200), contract parses, ETag present, no PII/note, dev hold excluded
      const judgeJwt = await signJwt(judgeSub, {
        scope: "merchant:schedule judge:abuse_lab",
        "https://velvetai.com/role_version": 1,
      });
      const judgeRes = await app.inject({
        method: "GET",
        url: `/v1/merchant/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { authorization: `Bearer ${judgeJwt}` },
      });
      expect(judgeRes.statusCode).toBe(200);
      const etag = judgeRes.headers.etag as string;
      expect(etag).toBeTruthy();

      const body = scheduleResponseSchema.parse(judgeRes.json());
      expect(body.events.some((e) => e.id === `hold_${judgeHold.bookingId}`)).toBe(true);
      expect(body.events.some((e) => e.id === `hold_${devHold.bookingId}`)).toBe(false);
      expect(body.events.some((e) => e.serviceName === "Dev Secret Service")).toBe(false);
      expect(body.events.some((e) => e.kind === "DEMO_FIXTURE")).toBe(true);

      const raw = JSON.stringify(body);
      expect(raw).not.toContain("@");
      expect(raw).not.toContain('"note"');
      expect(raw).not.toContain("PRIVATE CUSTOMER NOTE");
      for (const evt of body.events) {
        expect(evt.buyerLabel).not.toContain("@");
      }

      // 3. ETag If-None-Match -> 304 Not Modified
      const notModified = await app.inject({
        method: "GET",
        url: `/v1/merchant/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: {
          authorization: `Bearer ${judgeJwt}`,
          "if-none-match": etag,
        },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe("");

      // 4. Range > 14 days -> 400
      const tooWideTo = new Date(Date.now() + 16 * 86_400_000).toISOString();
      const wideRes = await app.inject({
        method: "GET",
        url: `/v1/merchant/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(tooWideTo)}`,
        headers: { authorization: `Bearer ${judgeJwt}` },
      });
      expect(wideRes.statusCode).toBe(400);
    } finally {
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx.deleteFrom("bookings").where("id", "=", judgeHold.bookingId).execute();
      });
      await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        await trx.deleteFrom("bookings").where("id", "=", devHold.bookingId).execute();
      });
    }
  });

  it("supports public read-only judge demo mode, rejects tenant overrides, rejects bad JWT, and rate-limits at 60/min/IP", async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 6 * 86_400_000).toISOString();

    // 1. Public unauthenticated read -> 200 masked judge tenant schedule
    const pubRes = await app.inject({
      method: "GET",
      url: `/v1/merchant/schedule?public=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    });
    expect(pubRes.statusCode).toBe(200);
    const parsed = scheduleResponseSchema.parse(pubRes.json());
    expect(parsed.resources.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(parsed)).not.toContain("@");
    expect(JSON.stringify(parsed)).not.toContain("Dev-Only Provider");

    // 2. Tenant override attempt rejected -> 400
    const overrideRes = await app.inject({
      method: "GET",
      url: `/v1/merchant/schedule?public=true&tenant_id=${DEV_TENANT_ID}`,
    });
    expect(overrideRes.statusCode).toBe(400);
    expect(overrideRes.json().code).toBe("tenant_override_forbidden");

    // 3. Forged Authorization header still fails 401 (never falls back to public)
    const forgedRes = await app.inject({
      method: "GET",
      url: "/v1/merchant/schedule?public=true",
      headers: { authorization: "Bearer forged.jwt.token" },
    });
    expect(forgedRes.statusCode).toBe(401);

    // 4. Rate limit at 60/min per IP -> 61st returns 429
    const testIp = "198.51.100.77";
    for (let i = 0; i < 60; i++) {
      const ok = await app.inject({
        method: "GET",
        url: `/v1/merchant/schedule?public=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        headers: { "x-forwarded-for": testIp },
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: `/v1/merchant/schedule?public=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { "x-forwarded-for": testIp },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json().code).toBe("rate_limit_exceeded");
  });
});
