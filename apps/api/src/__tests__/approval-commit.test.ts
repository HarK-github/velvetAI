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

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DEV_LOCATION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_SERVICE_ID = "01932b10-0001-7000-8000-000000000001";
const DEV_SERVICE_VERSION_ID = "01932b10-0002-7000-8000-000000000001";
const DEV_RESOURCE_ID = "01932b10-0004-7000-8000-000000000001";

const BUYER_A_USER_ID = "01932b10-0000-7000-8000-000000000010";
const BUYER_B_USER_ID = "01932b10-0000-7000-8000-000000000020";

const BUYER_A_TOKEN = `Bearer test-token:${BUYER_A_USER_ID}:${DEV_TENANT_ID}:BUYER:1`;
const BUYER_B_TOKEN = `Bearer test-token:${BUYER_B_USER_ID}:${DEV_TENANT_ID}:BUYER:1`;
const M2M_TOKEN = `Bearer test-token:m2m-agent@clients:${DEV_TENANT_ID}:BUYER:1`;

describe("Human Buyer Approve-and-Commit Route (POST /v1/booking-approvals/:locator/approve-and-commit)", () => {
  let app: FastifyInstance;
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    // Seed tenant
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

    // Seed users
    await db
      .insertInto("app_users")
      .values([
        {
          id: BUYER_A_USER_ID,
          oidc_subject: `auth0|buyer-a-${Date.now()}`,
          email_ciphertext: "buyer.a@example.com",
        },
        {
          id: BUYER_B_USER_ID,
          oidc_subject: `auth0|buyer-b-${Date.now()}`,
          email_ciphertext: "buyer.b@example.com",
        },
      ])
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    // Seed tenant-scoped fixtures
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
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
        .values([
          {
            id: crypto.randomUUID(),
            tenant_id: DEV_TENANT_ID,
            user_id: BUYER_A_USER_ID,
            role: "BUYER",
            role_version: 1,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: DEV_TENANT_ID,
            user_id: BUYER_B_USER_ID,
            role: "BUYER",
            role_version: 1,
          },
        ])
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
          duration_minutes: 60,
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
          resource_type: "STAFF",
          display_name: "Master Stylist Marcus",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();
    });

    app = buildApp({ db });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  let slotCounter = 1;
  const RUN_OFFSET_DAYS = 50 + Math.floor(Math.random() * 200);
  function getNextSlotStart(): string {
    slotCounter += 1;
    // Each hold is 2 hours apart in a unique future window so they never collide with other test suites
    return new Date(
      Date.now() + 86400_000 * RUN_OFFSET_DAYS + slotCounter * 7200_000,
    ).toISOString();
  }

  async function prepareTestHold(options?: {
    authHeader?: string;
    buyerEmail?: string;
    isM2M?: boolean;
  }) {
    const slotStart = getNextSlotStart();

    const headers: Record<string, string> = {
      "idempotency-key": `prep-${crypto.randomUUID()}`,
      authorization: options?.authHeader || BUYER_A_TOKEN,
    };

    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers,
      payload: {
        serviceId: DEV_SERVICE_ID,
        locationId: DEV_LOCATION_ID,
        startsAt: slotStart,
        timeZone: "America/New_York",
        customer: {
          displayName: "Test Customer",
          email: options?.buyerEmail || "buyer.a@example.com",
        },
      },
    });

    if (prepRes.statusCode !== 201) {
      console.error("prepareTestHold failed:", prepRes.statusCode, prepRes.body);
    }

    expect(prepRes.statusCode).toBe(201);
    const body = prepRes.json();
    return {
      bookingId: body.bookingId as string,
      intent: body.intent as string,
      approvalLocator: body.approvalLocator as string,
      locator: (body.approvalLocator as string).replace(/^\/v1\/booking-approvals\//, ""),
    };
  }

  // 1. Human buyer approve-and-commit -> 200, status COMMITTING, exactly 1 committed intent, exactly 1 outbox event
  it("1. Human buyer approve-and-commit -> 200, status COMMITTING, exactly 1 committed intent, exactly 1 outbox event", async () => {
    const hold = await prepareTestHold();
    const idempKey = crypto.randomUUID();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": idempKey,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bookingId).toBe(hold.bookingId);
    expect(body.status).toBe("COMMITTING");
    expect(body.next?.type).toBe("PAY_DEPOSIT");
    expect(body.next?.paymentOrderUrl).toBe(`/v1/bookings/${hold.bookingId}/payment-order`);

    // Verify database state: exactly 1 committed intent
    const committedIntents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", hold.bookingId)
        .selectAll()
        .execute();
    });
    expect(committedIntents).toHaveLength(1);

    // Verify database state: exactly 1 outbox event of booking.committing
    const outboxEvents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("outbox_events")
        .where("aggregate_id", "=", hold.bookingId)
        .where("event_type", "=", "booking.committing")
        .selectAll()
        .execute();
    });
    expect(outboxEvents).toHaveLength(1);

    // Verify audit event
    const auditEvents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("audit_events")
        .where("resource_id", "=", hold.bookingId)
        .where("action", "=", "booking.committed")
        .selectAll()
        .execute();
    });
    expect(auditEvents).toHaveLength(1);
  });

  // 2. Same Idempotency-Key replay -> same response, still exactly 1 committed intent
  it("2. Same Idempotency-Key replay -> same response, still exactly 1 committed intent", async () => {
    const hold = await prepareTestHold();
    const idempKey = crypto.randomUUID();

    const firstRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": idempKey,
      },
      payload: {},
    });
    expect(firstRes.statusCode).toBe(200);

    const replayRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": idempKey,
      },
      payload: {},
    });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json()).toEqual(firstRes.json());

    // Still exactly 1 committed intent
    const committedIntents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", hold.bookingId)
        .selectAll()
        .execute();
    });
    expect(committedIntents).toHaveLength(1);
  });

  // 3. M2M token -> 403 HUMAN_APPROVAL_REQUIRED, zero state change
  it("3. M2M token -> 403 HUMAN_APPROVAL_REQUIRED, zero state change", async () => {
    const hold = await prepareTestHold();
    const idempKey = crypto.randomUUID();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: M2M_TOKEN,
        "idempotency-key": idempKey,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("HUMAN_APPROVAL_REQUIRED");

    // Zero state change: booking remains HELD
    const booking = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", hold.bookingId)
        .select(["status"])
        .executeTakeFirst();
    });
    expect(booking?.status).toBe("HELD");

    // Zero committed intents
    const committedIntents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", hold.bookingId)
        .selectAll()
        .execute();
    });
    expect(committedIntents).toHaveLength(0);
  });

  // 4. No token -> 401 HUMAN_APPROVAL_REQUIRED, zero state change
  it("4. No token -> 401 HUMAN_APPROVAL_REQUIRED, zero state change", async () => {
    const hold = await prepareTestHold();
    const idempKey = crypto.randomUUID();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        "idempotency-key": idempKey,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe("HUMAN_APPROVAL_REQUIRED");

    // Zero state change
    const booking = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", hold.bookingId)
        .select(["status"])
        .executeTakeFirst();
    });
    expect(booking?.status).toBe("HELD");
  });

  // 5. Buyer B on Buyer A's hold -> 403 BUYER_MISMATCH, zero state change
  it("5. Buyer B on Buyer A's hold -> 403 BUYER_MISMATCH, zero state change", async () => {
    const hold = await prepareTestHold({
      authHeader: BUYER_A_TOKEN,
      buyerEmail: "buyer.a@example.com",
    });
    const idempKey = crypto.randomUUID();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_B_TOKEN,
        "idempotency-key": idempKey,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe("BUYER_MISMATCH");
    expect(body.detail).toBe("This approval belongs to another account.");

    // Zero state change
    const booking = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("bookings")
        .where("id", "=", hold.bookingId)
        .select(["status"])
        .executeTakeFirst();
    });
    expect(booking?.status).toBe("HELD");
  });

  // 6. M2M-prepared hold -> claimed by first human buyer; second human buyer receives 403 BUYER_MISMATCH
  it("6. M2M-prepared hold -> claimed by first human buyer; second human buyer receives 403 BUYER_MISMATCH", async () => {
    // Prepare hold with M2M agent token
    const hold = await prepareTestHold({
      authHeader: M2M_TOKEN,
      buyerEmail: "unassigned@example.com",
      isM2M: true,
    });

    // Verify hold started unbound (buyer_user_id is null)
    const initialConf = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("buyer_confirmations")
        .where("booking_id", "=", hold.bookingId)
        .select(["buyer_user_id"])
        .executeTakeFirst();
    });
    expect(initialConf?.buyer_user_id).toBeNull();

    // First human buyer (Buyer A) claims and approves
    const firstRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });

    expect(firstRes.statusCode).toBe(200);
    expect(firstRes.json().status).toBe("COMMITTING");

    // Verify audit event for claimed hold
    const claimAudit = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("audit_events")
        .where("resource_id", "=", hold.bookingId)
        .where("action", "=", "booking.claimed_by_buyer")
        .selectAll()
        .executeTakeFirst();
    });
    expect(claimAudit).toBeDefined();
    expect(claimAudit?.actor_id).toBe(BUYER_A_USER_ID);

    // Second human buyer (Buyer B) attempts approve-and-commit -> 403 BUYER_MISMATCH
    const secondRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_B_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });

    expect(secondRes.statusCode).toBe(403);
    expect(secondRes.json().code).toBe("BUYER_MISMATCH");
  });

  // 7. Expired hold -> 410 HOLD_EXPIRED, claim not blocking
  it("7. Expired hold -> 410 HOLD_EXPIRED, claim not blocking", async () => {
    const hold = await prepareTestHold();

    // Expire the hold in database
    const past = new Date(Date.now() - 60_000);
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .updateTable("buyer_confirmations")
        .set({ expires_at: past })
        .where("booking_id", "=", hold.bookingId)
        .execute();

      await trx
        .updateTable("bookings")
        .set({ hold_expires_at: past })
        .where("id", "=", hold.bookingId)
        .execute();
    });

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("HOLD_EXPIRED");
  });

  // 8. Agent commit after human approve-and-commit -> returns ALREADY_COMMITTED, still 1 booking
  it("8. Agent commit after human approve-and-commit -> returns ALREADY_COMMITTED, still 1 booking", async () => {
    const hold = await prepareTestHold();

    // 1. Human buyer approves and commits
    const humanRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });
    expect(humanRes.statusCode).toBe(200);

    // 2. Later, agent commits the same hold (agent pattern: intent + idempotency_key, no confirmation token)
    const agentIdempKey = crypto.randomUUID();
    const agentRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": agentIdempKey,
      },
      payload: {
        intent: hold.intent,
        idempotency_key: agentIdempKey,
      },
    });

    expect(agentRes.statusCode).toBe(200);
    const agentBody = agentRes.json();
    expect(agentBody.code).toBe("ALREADY_COMMITTED");
    expect(agentBody.status).toBe("COMMITTING");
    expect(agentBody.bookingId).toBe(hold.bookingId);

    // Verify still exactly 1 committed intent in database
    const committedIntents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", hold.bookingId)
        .selectAll()
        .execute();
    });
    expect(committedIntents).toHaveLength(1);
  });

  // 9. Human approve-and-commit after agent commit -> returns 200 with existing booking
  it("9. Human approve-and-commit after agent commit -> returns 200 with existing booking", async () => {
    const hold = await prepareTestHold();

    // 1. Human confirms hold (returns confirmation token)
    const confirmRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/confirm`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });
    expect(confirmRes.statusCode).toBe(200);
    const { confirmation } = confirmRes.json();

    // 2. Agent commits with confirmation token
    const agentIdemp = crypto.randomUUID();
    const commitRes = await app.inject({
      method: "POST",
      url: "/v1/bookings/commit",
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": agentIdemp,
      },
      payload: {
        intent: hold.intent,
        confirmation,
        idempotency_key: agentIdemp,
      },
    });
    expect(commitRes.statusCode).toBe(200);

    // 3. Human then calls approve-and-commit on the same locator -> returns 200 with existing booking
    const approveRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });

    expect(approveRes.statusCode).toBe(200);
    const approveBody = approveRes.json();
    expect(approveBody.bookingId).toBe(hold.bookingId);
    expect(approveBody.status).toBe("COMMITTING");
  });

  // 10. Response body never contains string starting with conf_
  it("10. Response body never contains string starting with conf_", async () => {
    const hold = await prepareTestHold();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("conf_");
    expect(res.body).not.toContain("confirmation");
  });

  // 11. Missing Idempotency-Key -> 400
  it("11. Missing Idempotency-Key -> 400", async () => {
    const hold = await prepareTestHold();

    const res = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: BUYER_A_TOKEN,
      },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  // 12. Concurrent race: two different human buyers approve-and-commit the same unassigned M2M hold simultaneously -> exactly one succeeds, the other gets BUYER_MISMATCH, exactly one committed intent
  it("12. Concurrent race: two different human buyers approve-and-commit the same unassigned M2M hold simultaneously -> exactly one succeeds, the other gets BUYER_MISMATCH, exactly one committed intent", async () => {
    const hold = await prepareTestHold({
      authHeader: M2M_TOKEN,
      buyerEmail: "unassigned-race@example.com",
      isM2M: true,
    });

    // Execute simultaneous approve-and-commit calls from Buyer A and Buyer B
    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
        headers: {
          authorization: BUYER_A_TOKEN,
          "idempotency-key": crypto.randomUUID(),
        },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
        headers: {
          authorization: BUYER_B_TOKEN,
          "idempotency-key": crypto.randomUUID(),
        },
        payload: {},
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([200, 403]);

    const winner = resA.statusCode === 200 ? resA : resB;
    const loser = resA.statusCode === 403 ? resA : resB;

    expect(winner.json().status).toBe("COMMITTING");
    expect(loser.json().code).toBe("BUYER_MISMATCH");
    expect(loser.json().detail).toBe("This approval belongs to another account.");

    // Exactly one committed intent in database
    const committedIntents = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", hold.bookingId)
        .selectAll()
        .execute();
    });
    expect(committedIntents).toHaveLength(1);
  });
});
