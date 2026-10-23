import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { buildApp } from "../app.js";

const TEST_DB_URL = getTestDatabaseUrl();

const TENANT_A = "01932b10-0000-7000-8000-000000000001";
const TENANT_B = "01932b10-0000-7000-8000-000000000002";
const LOCATION_ID = "01932b10-0002-7000-8000-000000000001";
const SERVICE_ID = "01932b10-0001-7000-8000-000000000001";
const SERVICE_VERSION_ID = "01932b10-0002-7000-8000-000000000001";
const RESOURCE_ID = "01932b10-0004-7000-8000-000000000001";

describe("W3: Mutation Idempotency Coverage & Concurrency Guarantees", () => {
  let app: FastifyInstance;
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    // Seed Tenant A and Tenant B
    await db
      .insertInto("tenants")
      .values([
        { id: TENANT_A, name: "Tenant A", default_currency: "USD", status: "ACTIVE" },
        { id: TENANT_B, name: "Tenant B", default_currency: "USD", status: "ACTIVE" },
      ])
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await withTenantTransaction(db, TENANT_A, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: LOCATION_ID,
          tenant_id: TENANT_A,
          name: "Flagship",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: SERVICE_ID,
          tenant_id: TENANT_A,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: SERVICE_VERSION_ID,
          tenant_id: TENANT_A,
          service_id: SERVICE_ID,
          version: 1,
          name: "Classic Cut",
          duration_minutes: 30,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "5000",
          base_deposit_minor: "1500",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: SERVICE_VERSION_ID })
        .where("id", "=", SERVICE_ID)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: RESOURCE_ID,
          tenant_id: TENANT_A,
          location_id: LOCATION_ID,
          resource_type: "CHAIR",
          display_name: "Chair 1",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();
    });

    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    await db.destroy();
  });

  it("1. Missing Idempotency-Key on mutating endpoint returns RFC 9457 HTTP 400 Problem Details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T10:00:00.000Z",
        timeZone: "America/New_York",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.status).toBe(400);
    expect(body.code).toBe("idempotency_key_required");
    expect(body.title).toContain("Idempotency-Key Required");
  });

  it("2. Exempt endpoint (POST /v1/risk/evaluate) succeeds without Idempotency-Key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/risk/evaluate",
      payload: { tier: "low" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().policyRoute).toBe("BASELINE");
  });

  it("3. Same key / same body returns cached response with X-Idempotent-Replay: true", async () => {
    const key = `key-same-body-${Date.now()}`;
    const payload = {
      serviceId: SERVICE_ID,
      locationId: LOCATION_ID,
      startsAt: "2026-12-01T11:00:00.000Z",
      timeZone: "America/New_York",
    };

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();

    // Second request: identical key and payload
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: { "idempotency-key": key },
      payload,
    });
    expect(res2.statusCode).toBe(201);
    expect(res2.headers["x-idempotent-replay"]).toBe("true");
    const body2 = res2.json();
    expect(body2.quoteId).toBe(body1.quoteId);
  });

  it("4. Same key / different body returns RFC 9457 HTTP 409 Conflict", async () => {
    const key = `key-diff-body-${Date.now()}`;

    // First request
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: { "idempotency-key": key },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T12:00:00.000Z",
        timeZone: "America/New_York",
      },
    });
    expect(res1.statusCode).toBe(201);

    // Second request with altered payload
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: { "idempotency-key": key },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T14:00:00.000Z", // Different startsAt
        timeZone: "America/New_York",
      },
    });

    expect(res2.statusCode).toBe(409);
    const body2 = res2.json();
    expect(body2.status).toBe(409);
    expect(body2.code).toBe("idempotency_conflict");
    expect(body2.detail).toContain("previously executed with a different request payload");
  });

  it("5. Same key across different operations returns RFC 9457 HTTP 409 Conflict", async () => {
    const key = `key-cross-op-${Date.now()}`;

    // Operation 1: POST /v1/booking-quotes
    const res1 = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: { "idempotency-key": key },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T15:00:00.000Z",
        timeZone: "America/New_York",
      },
    });
    expect(res1.statusCode).toBe(201);

    // Operation 2: POST /v1/bookings/prepare with same key
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: { "idempotency-key": key },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T15:00:00.000Z",
        timeZone: "America/New_York",
        customer: { displayName: "Cross Op", email: "cross@example.com" },
      },
    });

    expect(res2.statusCode).toBe(409);
    expect(res2.json().code).toBe("idempotency_conflict");
  });

  it("6. Same key across tenants executes independently without conflict", async () => {
    const key = `key-cross-tenant-${Date.now()}`;

    // Tenant A execution
    const resA = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: {
        "idempotency-key": key,
        "x-tenant-id": TENANT_A,
      },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T16:00:00.000Z",
        timeZone: "America/New_York",
      },
    });
    expect(resA.statusCode).toBe(201);

    // Tenant B execution with exact same key and payload
    // Tenant B has no services seeded so it returns 404, proving independent tenant execution without 409 conflict
    const resB = await app.inject({
      method: "POST",
      url: "/v1/booking-quotes",
      headers: {
        "idempotency-key": key,
        "x-tenant-id": TENANT_B,
      },
      payload: {
        serviceId: SERVICE_ID,
        locationId: LOCATION_ID,
        startsAt: "2026-12-01T16:00:00.000Z",
        timeZone: "America/New_York",
      },
    });

    // Tenant B did not conflict (status 409) with Tenant A's idempotency key
    expect(resB.statusCode).not.toBe(409);
  });

  it("7. 100 concurrent identical requests converge to exactly one operation", async () => {
    const key = `key-100-concurrent-${Date.now()}`;
    const payload = {
      serviceId: SERVICE_ID,
      locationId: LOCATION_ID,
      startsAt: "2026-12-02T10:00:00.000Z",
      timeZone: "America/New_York",
    };

    const requests = Array.from({ length: 100 }, () =>
      app.inject({
        method: "POST",
        url: "/v1/booking-quotes",
        headers: { "idempotency-key": key },
        payload,
      }),
    );

    const responses = await Promise.all(requests);

    // Every single request must return 201 Created
    for (const r of responses) {
      expect(r.statusCode).toBe(201);
    }

    // Every response must return the exact same quoteId
    const quoteIds = responses.map((r) => r.json().quoteId);
    const uniqueQuoteIds = new Set(quoteIds);
    expect(uniqueQuoteIds.size).toBe(1);

    // Exactly 99 of the 100 requests were replayed from the single convergent operation
    const replayed = responses.filter((r) => r.headers["x-idempotent-replay"] === "true");
    expect(replayed.length).toBe(99);
  });
});
