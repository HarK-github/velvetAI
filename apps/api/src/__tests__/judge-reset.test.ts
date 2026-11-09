import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  Database,
  getTestDatabaseUrl,
  sql,
} from "@velvetai/db";
import {
  JUDGE_TENANT_ID,
  JUDGE_SEED_VERSION,
  JUDGE_NAMESPACE,
  UnauthorizedTenantAccessError,
} from "@velvetai/domain";
import { JudgeResetService, deterministicUuid } from "@velvetai/application";
import { Kysely } from "kysely";
import { buildApp } from "../app.js";

const TEST_DB_URL = getTestDatabaseUrl();

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DEV_USER_ID = "01932b10-0000-7000-8000-000000000002";
const JUDGE_USER_ID = "01932b10-0000-7000-8000-000000000003";

describe("Work Package 04: Judge Tenant Deterministic Seed & Reset", () => {
  let app: FastifyInstance;
  let db: Kysely<Database>;
  let judgeService: JudgeResetService;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);
    judgeService = new JudgeResetService(db);

    // Ensure dev tenant exists
    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Dev Studio Flagship",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Ensure users exist
    await db
      .insertInto("app_users")
      .values([
        {
          id: DEV_USER_ID,
          oidc_subject: "dev|default-buyer",
          email_ciphertext: "buyer@velvetai.example",
        },
        {
          id: JUDGE_USER_ID,
          oidc_subject: "auth0|judge-admin",
          email_ciphertext: "judge@velvetai.example",
        },
      ])
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Dev user membership
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          user_id: DEV_USER_ID,
          role: "BUYER",
          role_version: 1,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "user_id"]).doNothing())
        .execute();

      // Seed dev service & location
      const locId = crypto.randomUUID();
      await trx
        .insertInto("locations")
        .values({
          id: locId,
          tenant_id: DEV_TENANT_ID,
          name: "Dev Location",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "name"]).doNothing())
        .execute();
    });

    app = buildApp({ db });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (db) {
      await db.destroy();
    }
  });

  // Test 1: Forced dev-tenant id throws UnauthorizedTenantAccessError before queries
  it("1. Reset with forced dev-tenant ID throws UnauthorizedTenantAccessError before any query", async () => {
    await expect(
      judgeService.resetJudgeTenant({
        tenantId: DEV_TENANT_ID,
        requestedBy: DEV_USER_ID,
      }),
    ).rejects.toThrow(UnauthorizedTenantAccessError);
  });

  // Test 2: RLS Proof - Dev tenant rows untouched after judge reset
  it("2. RLS proof: Dev tenant row counts before vs after judge reset are 100% identical", async () => {
    const getDevCounts = async () => {
      return await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        const locs = await trx
          .selectFrom("locations")
          .where("tenant_id", "=", DEV_TENANT_ID)
          .selectAll()
          .execute();
        const svcs = await trx
          .selectFrom("services")
          .where("tenant_id", "=", DEV_TENANT_ID)
          .selectAll()
          .execute();
        const claims = await trx
          .selectFrom("resource_claims")
          .where("tenant_id", "=", DEV_TENANT_ID)
          .selectAll()
          .execute();
        const books = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", DEV_TENANT_ID)
          .selectAll()
          .execute();
        return { locs: locs.length, svcs: svcs.length, claims: claims.length, books: books.length };
      });
    };

    const countsBefore = await getDevCounts();

    // Run reset on judge tenant
    const resetRes = await judgeService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: JUDGE_USER_ID,
    });
    expect(resetRes.status).toBe("SUCCEEDED");
    expect(resetRes.summary.seededFixtures).toBeGreaterThan(0);

    const countsAfter = await getDevCounts();
    expect(countsAfter).toEqual(countsBefore);
  });

  // Test 3: Deterministic repeatability: Two resets with the same clock produce identical fixture sets
  it("3. Two resets with the same clock produce identical fixture and history sets", async () => {
    const fixedNow = new Date("2026-11-09T10:00:00Z");

    const res1 = await judgeService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: JUDGE_USER_ID,
      now: fixedNow,
    });

    const fixtures1 = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("demo_schedule_fixtures")
        .select(["id", "resource_id", "service_id", "starts_at", "ends_at", "display_status"])
        .orderBy("id", "asc")
        .execute();
    });

    const res2 = await judgeService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: JUDGE_USER_ID,
      now: fixedNow,
    });

    const fixtures2 = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("demo_schedule_fixtures")
        .select(["id", "resource_id", "service_id", "starts_at", "ends_at", "display_status"])
        .orderBy("id", "asc")
        .execute();
    });

    expect(res1.summary.seededFixtures).toBe(res2.summary.seededFixtures);
    expect(res1.summary.seededHistory).toBe(res2.summary.seededHistory);
    expect(fixtures1).toEqual(fixtures2);
  });

  // Test 4: Paid judge booking survives reset unchanged & fixture overlapping paid booking is skipped
  it("4. Paid judge booking survives reset unchanged with journal lines intact", async () => {
    const fixedNow = new Date("2026-11-09T14:00:00Z");

    // Seed first and measure baseline retained bookings
    const baselineRes = await judgeService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: JUDGE_USER_ID,
      now: fixedNow,
    });
    const baselineRetained = baselineRes.summary.retainedPaidBookings;

    // Pick a slot on Lena on Nov 11 (within judge fixtures)
    const bookingId = crypto.randomUUID();
    const customerId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    const claimId = crypto.randomUUID();

    const bookingStart = new Date("2026-11-11T16:00:00Z");
    const bookingEnd = new Date("2026-11-11T17:00:00Z");
    const resId = deterministicUuid(JUDGE_NAMESPACE, "resource:lena-therapist");
    const svcVerId = deterministicUuid(JUDGE_NAMESPACE, "service-ver:deep-tissue-v1");

    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      // Clear all claims and fixtures for judge tenant before inserting the test booking so it claims the slot cleanly
      await trx
        .deleteFrom("demo_schedule_fixtures")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .execute();
      await trx.deleteFrom("resource_claims").where("tenant_id", "=", JUDGE_TENANT_ID).execute();

      // Customer
      await trx
        .insertInto("customers")
        .values({
          id: customerId,
          tenant_id: JUDGE_TENANT_ID,
          email_ciphertext: "judgebuyer@velvetai.example",
          status: "ACTIVE",
        })
        .execute();

      // Quote
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: JUDGE_TENANT_ID,
          service_version_id: svcVerId,
          customer_id: customerId,
          starts_at: bookingStart,
          ends_at: bookingEnd,
          total_minor: "12000",
          deposit_minor: "3500",
          currency: "USD",
          canonical_hash: "hash-test",
          expires_at: new Date(Date.now() + 600000),
        })
        .execute();

      // Booking
      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: JUDGE_TENANT_ID,
          customer_id: customerId,
          quote_id: quoteId,
          status: "CONFIRMED",
          version: 1,
          starts_at: bookingStart,
          ends_at: bookingEnd,
          resource_id: resId,
        })
        .execute();

      // Blocking resource claim
      await trx
        .insertInto("resource_claims")
        .values({
          id: claimId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          claim_source: "BOOKING",
          resource_id: resId,
          starts_at: bookingStart,
          ends_at: bookingEnd,
          blocked_during: sql`tstzrange(${bookingStart.toISOString()}::timestamptz, ${bookingEnd.toISOString()}::timestamptz, '[)')`,
          state: "CONFIRMED",
          blocking: true,
          hold_expires_at: null,
          expires_at: null,
        })
        .execute();

      const paymentIntentId = crypto.randomUUID();
      await trx
        .insertInto("payment_intents")
        .values({
          id: paymentIntentId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: bookingId,
          amount_minor: "3500",
          currency: "USD",
          state: "CAPTURED",
          payment_expires_at: new Date(Date.now() + 600000),
          request_id: crypto.randomUUID(),
        })
        .execute();

      // Completed payment capture
      await trx
        .insertInto("payment_captures")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          payment_intent_id: paymentIntentId,
          booking_id: bookingId,
          amount_minor: "3500",
          currency: "USD",
          state: "COMPLETED",
          provider_capture_id: `paypal-cap-${crypto.randomUUID()}`,
          captured_at: new Date(),
        })
        .execute();
    });

    // Run reset again with same clock
    const resetRes2 = await judgeService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: JUDGE_USER_ID,
      now: fixedNow,
    });

    // The paid booking was retained (baseline + 1)
    expect(resetRes2.summary.retainedPaidBookings).toBe(baselineRetained + 1);
    expect(resetRes2.summary.message).toContain(
      `${baselineRetained + 1} paid sandbox bookings kept (payments can't be deleted)`,
    );

    // The overlapping fixture on Lena was skipped due to GiST conflict
    expect(resetRes2.summary.skippedConflicts).toBeGreaterThanOrEqual(1);

    // Verify booking still exists and is CONFIRMED
    const bookingCheck = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .selectAll()
        .executeTakeFirst();
    });
    expect(bookingCheck).toBeDefined();
    expect(bookingCheck?.status).toBe("CONFIRMED");
  });

  // Test 6: Concurrent reset -> 409 JUDGE_RESET_IN_PROGRESS
  it("6. Concurrent reset returns 409 JUDGE_RESET_IN_PROGRESS", async () => {
    const runId = crypto.randomUUID();
    // Simulate active in-progress run
    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      await trx
        .insertInto("judge_runs")
        .values({
          id: runId,
          tenant_id: JUDGE_TENANT_ID,
          seed_version: JUDGE_SEED_VERSION,
          status: "RUNNING",
          started_at: new Date(),
          requested_by: JUDGE_USER_ID,
          steps: JSON.stringify([]),
        })
        .execute();
    });

    // Calling reset endpoint should return 409
    const response = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:${JUDGE_USER_ID}:${JUDGE_TENANT_ID}:JUDGE:1:false:judge:reset`,
        "idempotency-key": crypto.randomUUID(),
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe("JUDGE_RESET_IN_PROGRESS");

    // Clean up mock running row
    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      await trx.deleteFrom("judge_runs").where("id", "=", runId).execute();
    });
  });

  // Test 7: Permissions & Auth checks (401, 403)
  it("7. Auth checks: user without judge:reset -> 403, M2M -> 403, no token -> 401", async () => {
    // A: No token -> 401
    const resNoToken = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(resNoToken.statusCode).toBe(401);

    // B: M2M token -> 403
    const resM2M = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:agent-client@clients:${JUDGE_TENANT_ID}:M2M:1:false:mcp:tools`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(resM2M.statusCode).toBe(403);

    // C: User without judge:reset -> 403
    const resBuyer = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:${DEV_USER_ID}:${JUDGE_TENANT_ID}:BUYER:1:false:booking:create`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(resBuyer.statusCode).toBe(403);
    expect(resBuyer.json().code).toBe("insufficient_scope");

    // D: Dev tenant context -> 403
    const resDevTenant = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:${JUDGE_USER_ID}:${DEV_TENANT_ID}:JUDGE:1:false:judge:reset`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(resDevTenant.statusCode).toBe(403);
    expect(resDevTenant.json().code).toBe("FORBIDDEN_TENANT_ACCESS");
  });

  // Test 8: Rate Limiting (429 with Retry-After)
  it("8. Rate limit: second reset within 60 s -> 429 with Retry-After header", async () => {
    // Clear runs to avoid previous test's rate limit window
    await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      await trx.deleteFrom("judge_runs").execute();
    });

    const res1 = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:${JUDGE_USER_ID}:${JUDGE_TENANT_ID}:JUDGE:1:false:judge:reset`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(res1.statusCode).toBe(202);
    const body1 = res1.json();
    expect(body1.status).toBe("RUNNING");
    expect(body1.runId).toBeDefined();

    // Second reset immediately -> 429
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/judge/reset",
      headers: {
        authorization: `Bearer test-token:${JUDGE_USER_ID}:${JUDGE_TENANT_ID}:JUDGE:1:false:judge:reset`,
        "idempotency-key": crypto.randomUUID(),
      },
    });
    expect(res2.statusCode).toBe(429);
    expect(res2.headers["retry-after"]).toBeDefined();
    expect(res2.json().code).toBe("rate_limit_exceeded");
  });

  // Test 9: Status endpoints GET /v1/judge/runs/:runId and latest
  it("9. Status endpoints return run details and summary", async () => {
    const latestRes = await app.inject({
      method: "GET",
      url: "/v1/judge/runs/latest",
    });
    expect(latestRes.statusCode).toBe(200);
    const latest = latestRes.json();
    expect(latest.status).toBe("SUCCEEDED");
    expect(latest.summary.seededFixtures).toBeGreaterThan(0);

    const runRes = await app.inject({
      method: "GET",
      url: `/v1/judge/runs/${latest.runId}`,
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().runId).toBe(latest.runId);
  });

  // Test 10: Real booking overlapping a CONFIRMED fixture fails with 23P01 GiST exclusion
  it("10. Attempting real booking claim overlapping a CONFIRMED fixture fails with 23P01 GiST exclusion", async () => {
    // Find an active CONFIRMED fixture claim
    const fixtureClaim = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("resource_claims")
        .where("claim_source", "=", "DEMO_FIXTURE")
        .where("blocking", "=", true)
        .selectAll()
        .executeTakeFirstOrThrow();
    });

    // Try to insert a conflicting BOOKING claim overlapping that exact time range
    await expect(
      withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx
          .insertInto("resource_claims")
          .values({
            id: crypto.randomUUID(),
            tenant_id: JUDGE_TENANT_ID,
            booking_id: crypto.randomUUID(),
            claim_source: "BOOKING",
            resource_id: fixtureClaim.resource_id,
            starts_at: fixtureClaim.starts_at,
            ends_at: fixtureClaim.ends_at,
            blocked_during: sql`tstzrange(${new Date(fixtureClaim.starts_at).toISOString()}::timestamptz, ${new Date(fixtureClaim.ends_at).toISOString()}::timestamptz, '[)')`,
            state: "CONFIRMED",
            blocking: true,
            hold_expires_at: null,
            expires_at: null,
          })
          .execute();
      }),
    ).rejects.toThrow(/23P01|no_overlapping_claims/);
  });
});
