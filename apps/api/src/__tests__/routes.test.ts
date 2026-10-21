import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { buildApp } from "../app.js";

const TEST_DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable";

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DEV_USER_ID = "01932b10-0000-7000-8000-000000000002";
const DEV_LOCATION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_SERVICE_ID = "01932b10-0001-7000-8000-000000000001";
const DEV_SERVICE_VERSION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_RESOURCE_ID = "01932b10-0004-7000-8000-000000000001";

describe("API Frontend Endpoints & Middleware", () => {
  let app: FastifyInstance;
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    // Ensure dev tenant exists
    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Velvet Flagship Manhattan",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Ensure dev user exists
    await db
      .insertInto("app_users")
      .values({
        id: DEV_USER_ID,
        oidc_subject: "dev|default-owner",
        email_ciphertext: "owner@velvetai.example",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Seed tenant-scoped fixtures within tenant context
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx.deleteFrom("resource_claims").execute();

      await trx
        .insertInto("locations")
        .values({
          id: DEV_LOCATION_ID,
          tenant_id: DEV_TENANT_ID,
          name: "SoHo Flagship",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: DEV_USER_ID,
          role: "OWNER",
          role_version: 1,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: DEV_SERVICE_ID,
          tenant_id: DEV_TENANT_ID,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: DEV_SERVICE_VERSION_ID,
          tenant_id: DEV_TENANT_ID,
          service_id: DEV_SERVICE_ID,
          version: 1,
          name: "Executive Haircut & Beard Sculpt",
          duration_minutes: 45,
          buffer_before_minutes: 0,
          buffer_after_minutes: 15,
          price_minor: "7500",
          base_deposit_minor: "2000",
          currency: "USD",
          cancellation_policy_id: "01932b10-0003-7000-8000-000000000001",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: DEV_SERVICE_VERSION_ID })
        .where("id", "=", DEV_SERVICE_ID)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: DEV_RESOURCE_ID,
          tenant_id: DEV_TENANT_ID,
          location_id: DEV_LOCATION_ID,
          resource_type: "CHAIR",
          display_name: "Master Chair 1",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();
    });

    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    await db.destroy();
  });

  it("GET /v1/services returns versioned service catalog", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.services[0].versions[0].name).toBe("Executive Haircut & Beard Sculpt");
    expect(body.services[0].versions[0].priceMinor).toBe(7500);
    expect(body.services[0].versions[0].baseDepositMinor).toBe(2000);
  });

  it("GET /v1/availability returns conflict-free slots with probabilities", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/availability?serviceId=${DEV_SERVICE_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scheduleRevision).toBe(14);
    expect(Array.isArray(body.slots)).toBe(true);
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.slots[0].fillProbability).toBeDefined();
    expect(body.slots[0].depositPreview.valueMinor).toBe("2000");
  });

  it("POST /v1/booking-quotes calculates quote and deposit breakdown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      payload: {
        serviceId: DEV_SERVICE_ID,
        locationId: DEV_LOCATION_ID,
        startsAt: "2026-11-20T10:00:00.000Z",
        timeZone: "America/New_York",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.quoteId).toBeDefined();
    expect(body.total.valueMinor).toBe("7500");
    expect(body.deposit.valueMinor).toBe("2000");
    expect(body.cancellationPolicy.summary).toContain("refund");
  });

  it("Full booking pipeline: prepare -> get approval -> confirm approval -> commit", async () => {
    const slotStart = new Date(Date.now() + 86400_000 * 30 + Math.floor(Math.random() * 1000000000)).toISOString();

    // 1. Prepare booking (slot hold + signed intent + approval locator)
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      payload: {
        serviceId: DEV_SERVICE_ID,
        locationId: DEV_LOCATION_ID,
        startsAt: slotStart,
        timeZone: "America/New_York",
        customer: {
          displayName: "E2E Buyer",
          email: "e2e.buyer@example.com",
        },
      },
    });

    expect(prepRes.statusCode).toBe(201);
    const prepBody = prepRes.json();
    expect(prepBody.bookingId).toBeDefined();
    expect(prepBody.status).toBe("HELD");
    expect(prepBody.intent).toBeDefined();
    expect(prepBody.approvalLocator).toBeDefined();

    // 2. GET approval terms with security headers per Amendment D.4
    const approvalRes = await app.inject({
      method: "GET",
      url: prepBody.approvalLocator,
    });

    expect(approvalRes.statusCode).toBe(200);
    expect(approvalRes.headers["cache-control"]).toBe("no-store");
    expect(approvalRes.headers["referrer-policy"]).toBe("no-referrer");
    expect(approvalRes.headers["content-security-policy"]).toBe("frame-ancestors 'none'");

    const approvalBody = approvalRes.json();
    expect(approvalBody.bookingId).toBe(prepBody.bookingId);
    expect(approvalBody.allInPriceMinor).toBe("7500");

    // 3. Buyer confirms terms -> issues one-time confirmation token
    const confirmRes = await app.inject({
      method: "POST",
      url: `${prepBody.approvalLocator}/confirm`,
    });

    expect(confirmRes.statusCode).toBe(200);
    const confirmBody = confirmRes.json();
    expect(confirmBody.confirmation).toBeDefined();

    // 4. Atomic commit operation -> status COMMITTING
    const commitRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      payload: {
        intent: prepBody.intent,
        confirmation: confirmBody.confirmation,
        idempotency_key: `idemp-e2e-${Date.now()}`,
      },
    });

    expect(commitRes.statusCode).toBe(200);
    const commitBody = commitRes.json();
    expect(commitBody.bookingId).toBe(prepBody.bookingId);
    expect(commitBody.status).toBe("COMMITTING");

    // 5. GET /v1/bookings/:id
    const fetchRes = await app.inject({
      method: "GET",
      url: `/v1/bookings/${prepBody.bookingId}`,
    });
    expect(fetchRes.statusCode).toBe(200);
    expect(fetchRes.json().id).toBe(prepBody.bookingId);
  });

  it("POST /v1/risk/evaluate computes deterministic policy routes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/risk/evaluate",
      payload: { tier: "elevated" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policyRoute).toBe("REMINDER");
    expect(body.noShowProbability).toBe("19%");
    expect(body.depositTierPercent).toBe("20%");
  });

  describe("Idempotency Middleware", () => {
    it("returns cached result on same Idempotency-Key and payload", async () => {
      const idempotencyKey = `key-test-idem-${Date.now()}`;
      const payload = { tier: "low" };

      // Call 1
      const res1 = await app.inject({
        method: "POST",
        url: "/v1/risk/evaluate",
        headers: { "idempotency-key": idempotencyKey },
        payload,
      });
      expect(res1.statusCode).toBe(200);

      // Call 2 with identical key and payload
      const res2 = await app.inject({
        method: "POST",
        url: "/v1/risk/evaluate",
        headers: { "idempotency-key": idempotencyKey },
        payload,
      });
      expect(res2.statusCode).toBe(200);
      expect(res2.headers["x-idempotent-replay"]).toBe("true");
      expect(res2.json()).toEqual(res1.json());
    });

    it("returns HTTP 409 Problem Details on same Idempotency-Key with different payload", async () => {
      const idempotencyKey = `key-conflict-${Date.now()}`;

      // Call 1
      const res1 = await app.inject({
        method: "POST",
        url: "/v1/risk/evaluate",
        headers: { "idempotency-key": idempotencyKey },
        payload: { tier: "low" },
      });
      expect(res1.statusCode).toBe(200);

      // Call 2 with same key but altered payload
      const res2 = await app.inject({
        method: "POST",
        url: "/v1/risk/evaluate",
        headers: { "idempotency-key": idempotencyKey },
        payload: { tier: "high" }, // Conflict!
      });
      expect(res2.statusCode).toBe(409);
      const problem = res2.json();
      expect(problem.code).toBe("idempotency_conflict");
      expect(problem.status).toBe(409);
    });

    it("Requirement 2: rejects real HTTP request containing duplicate JSON keys with 400 Problem Details", async () => {
      // Wire representation with duplicate "amount" key
      const rawDuplicatePayload = '{"serviceId":"01932b10-0001-7000-8000-000000000001","locationId":"01932b10-0004-7000-8000-000000000001","startsAt":"2026-11-20T10:00:00.000Z","timeZone":"America/New_York","amount":"1000","amount":"9000"}';

      const res = await app.inject({
        method: "POST",
        url: "/v1/booking-quotes",
        headers: {
          "content-type": "application/json",
        },
        payload: rawDuplicatePayload,
      });

      expect(res.statusCode).toBe(400);
      const problem = res.json();
      expect(problem.title).toBe("Validation Error");
      expect(problem.status).toBe(400);
      expect(problem.detail).toContain('Duplicate JSON key detected: "amount"');
    });
  });
});
