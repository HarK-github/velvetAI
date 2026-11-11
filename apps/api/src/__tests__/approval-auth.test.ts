import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import * as jose from "jose";
import {
  createDatabaseClient,
  migrateToLatest,
  getTestDatabaseUrl,
  withTenantTransaction,
  Database,
} from "@velvetai/db";
import { Kysely } from "kysely";
import { validateEnv } from "@velvetai/observability";
import { buildApp } from "../app.js";
import { Auth0AuthenticationAdapter, setAuthAdapter } from "../plugins/auth.js";

const TEST_DB_URL = getTestDatabaseUrl();

const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";
const DEV_LOCATION_ID = "01932b10-0002-7000-8000-000000000001";
const SEC_SERVICE_ID = crypto.randomUUID();
const SEC_SERVICE_VERSION_ID = crypto.randomUUID();
const SEC_RESOURCE_ID = crypto.randomUUID();

describe("Booking Approval Route Auth0 RS256 Security (P0-8)", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let origMockEnabled: string | undefined;

  let validKeyPair: jose.GenerateKeyPairResult;
  let attackerKeyPair: jose.GenerateKeyPairResult;
  let testIssuer: string;
  let testAudience: string;

  const buyerUserId = crypto.randomUUID();
  const buyerSub = `auth0|approval-buyer-${buyerUserId}`;
  const m2mUserId = crypto.randomUUID();
  const m2mSub = `client_approval_${m2mUserId}@clients`;
  const unprovisionedM2mSub = `client_unprovisioned_${crypto.randomUUID()}@clients`;

  let slotCounter = 1;
  const runOffsetDays = 300 + Math.floor(Math.random() * 150);
  function nextSlotStart(): string {
    slotCounter += 1;
    return new Date(Date.now() + 86400_000 * runOffsetDays + slotCounter * 7200_000).toISOString();
  }

  async function signJwt(
    claims: Record<string, unknown>,
    options?: {
      privateKey?: jose.KeyLike;
      audience?: string;
      issuer?: string;
      expiration?: string | number;
    },
  ): Promise<string> {
    const builder = new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(options?.issuer ?? testIssuer)
      .setAudience(options?.audience ?? testAudience)
      .setIssuedAt();

    if (typeof options?.expiration === "number") {
      builder.setExpirationTime(options.expiration);
    } else {
      builder.setExpirationTime(options?.expiration ?? "2h");
    }

    return await builder.sign(options?.privateKey ?? validKeyPair.privateKey);
  }

  async function prepareHold(buyerJwt: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/bookings/prepare",
      headers: {
        authorization: `Bearer ${buyerJwt}`,
        "idempotency-key": `prep-${crypto.randomUUID()}`,
      },
      payload: {
        serviceId: SEC_SERVICE_ID,
        locationId: DEV_LOCATION_ID,
        startsAt: nextSlotStart(),
        timeZone: "America/New_York",
        customer: {
          displayName: "RS256 Buyer",
          email: "buyer.rs256@example.com",
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const bookingId = body.bookingId as string;

    const initialConfirmation = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      return await trx
        .selectFrom("buyer_confirmations")
        .where("booking_id", "=", bookingId)
        .select(["token_hash", "confirmation_jti", "consumed_at"])
        .executeTakeFirst();
    });

    return {
      bookingId,
      locator: (body.approvalLocator as string).replace(/^\/v1\/booking-approvals\//, ""),
      initialTokenHash: initialConfirmation?.token_hash,
      initialJti: initialConfirmation?.confirmation_jti,
    };
  }

  async function assertZeroBookingStateChange(
    bookingId: string,
    initialTokenHash: string | undefined,
    initialJti: string | undefined,
  ) {
    const state = await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .select(["status", "version"])
        .executeTakeFirst();
      const confirmation = await trx
        .selectFrom("buyer_confirmations")
        .where("booking_id", "=", bookingId)
        .select(["token_hash", "confirmation_jti", "consumed_at"])
        .executeTakeFirst();
      const committed = await trx
        .selectFrom("committed_intents")
        .where("booking_id", "=", bookingId)
        .select(["id"])
        .execute();
      return { booking, confirmation, committedCount: committed.length };
    });

    expect(state.booking?.status).toBe("HELD");
    expect(state.booking?.version).toBe(1);
    expect(state.confirmation?.consumed_at ?? null).toBeNull();
    expect(state.confirmation?.token_hash).toBe(initialTokenHash);
    expect(state.confirmation?.confirmation_jti).toBe(initialJti);
    expect(state.committedCount).toBe(0);
  }

  beforeAll(async () => {
    origMockEnabled = process.env.OIDC_MOCK_ENABLED;
    process.env.OIDC_MOCK_ENABLED = "false";

    const env = validateEnv();
    testIssuer = env.AUTH0_ISSUER;
    testAudience = env.AUTH0_AUDIENCE;

    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 10 });
    await migrateToLatest(db);

    validKeyPair = await jose.generateKeyPair("RS256");
    attackerKeyPair = await jose.generateKeyPair("RS256");

    await db
      .insertInto("tenants")
      .values({
        id: DEV_TENANT_ID,
        name: "Dev Salon",
        default_currency: "USD",
        status: "ACTIVE",
      })
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();

    await db
      .insertInto("app_users")
      .values([
        {
          id: buyerUserId,
          oidc_subject: buyerSub,
          email_ciphertext: "buyer.rs256@example.com",
        },
        {
          id: m2mUserId,
          oidc_subject: m2mSub,
          email_ciphertext: "m2m.client@example.com",
        },
      ])
      .execute();

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: DEV_LOCATION_ID,
          tenant_id: DEV_TENANT_ID,
          name: "Manhattan Flagship",
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
            user_id: buyerUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: DEV_TENANT_ID,
            user_id: m2mUserId,
            role: "BUYER",
            role_version: 1,
            revoked_at: null,
          },
        ])
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: SEC_SERVICE_ID,
          tenant_id: DEV_TENANT_ID,
          status: "ACTIVE",
          current_version_id: null,
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: SEC_SERVICE_VERSION_ID,
          tenant_id: DEV_TENANT_ID,
          service_id: SEC_SERVICE_ID,
          version: 1,
          name: "Security Test Haircut",
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
        .set({ current_version_id: SEC_SERVICE_VERSION_ID })
        .where("id", "=", SEC_SERVICE_ID)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: SEC_RESOURCE_ID,
          tenant_id: DEV_TENANT_ID,
          location_id: DEV_LOCATION_ID,
          resource_type: "STAFF",
          display_name: "Security Stylist",
          status: "ACTIVE",
        })
        .onConflict((oc) => oc.columns(["tenant_id", "id"]).doNothing())
        .execute();
    });

    const localKeySet: jose.JWTVerifyGetKey = async () => validKeyPair.publicKey;
    const adapter = new Auth0AuthenticationAdapter({
      db,
      issuer: testIssuer,
      audience: testAudience,
      localKeySet,
      allowDevTokens: false,
    });
    setAuthAdapter(adapter);
    app = buildApp({ db });
    await app.ready();
  });

  afterAll(async () => {
    if (origMockEnabled !== undefined) {
      process.env.OIDC_MOCK_ENABLED = origMockEnabled;
    } else {
      delete process.env.OIDC_MOCK_ENABLED;
    }
    await app?.close();
    await db?.destroy();
  });

  const postRoutes = ["confirm", "approve-and-commit"] as const;

  it("allows unauthenticated GET /v1/booking-approvals/:locator (read-only terms remain public)", async () => {
    const buyerJwt = await signJwt({
      sub: buyerSub,
      email: "buyer.rs256@example.com",
      scope: "booking:prepare booking:commit booking:read",
      "https://velvetai.com/role_version": 1,
    });
    const hold = await prepareHold(buyerJwt);

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/booking-approvals/${hold.locator}`,
      headers: {
        origin: "http://localhost:5174",
      },
    });

    expect(getRes.statusCode).toBe(200);
    expect(String(getRes.headers["access-control-expose-headers"] || "")).toContain("Date");
    const body = getRes.json();
    expect(body.bookingId).toBe(hold.bookingId);
    expect(body.status).toBe("PENDING");
  });

  for (const action of postRoutes) {
    describe(`POST /v1/booking-approvals/:locator/${action}`, () => {
      it("rejects missing bearer token with 401 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            "idempotency-key": `noauth-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(401);
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("rejects forged RS256 signature with 401 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const forgedJwt = await signJwt(
          {
            sub: buyerSub,
            scope: "booking:commit",
            "https://velvetai.com/role_version": 1,
          },
          { privateKey: attackerKeyPair.privateKey },
        );

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${forgedJwt}`,
            "idempotency-key": `forged-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(401);
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("rejects wrong audience JWT with 401 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const wrongAudJwt = await signJwt(
          {
            sub: buyerSub,
            scope: "booking:commit",
            "https://velvetai.com/role_version": 1,
          },
          { audience: "https://wrong-audience.example/api" },
        );

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${wrongAudJwt}`,
            "idempotency-key": `wrong-aud-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(401);
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("rejects expired JWT with 401 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const expiredExp = Math.floor(Date.now() / 1000) - 3600;
        const expiredJwt = await signJwt(
          {
            sub: buyerSub,
            scope: "booking:commit",
            "https://velvetai.com/role_version": 1,
          },
          { expiration: expiredExp },
        );

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${expiredJwt}`,
            "idempotency-key": `expired-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(401);
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("rejects provisioned M2M @clients token with 403 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const m2mJwt = await signJwt({
          sub: m2mSub,
          gty: "client-credentials",
          scope: "booking:commit",
          "https://velvetai.com/role_version": 1,
        });

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${m2mJwt}`,
            "idempotency-key": `m2m-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(403);
        const body = res.json();
        expect(body.code).toBe("HUMAN_APPROVAL_REQUIRED");
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("rejects unprovisioned M2M @clients token with 403 and zero DB state change", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const m2mJwt = await signJwt({
          sub: unprovisionedM2mSub,
          gty: "client-credentials",
          scope: "booking:commit",
        });

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${m2mJwt}`,
            "idempotency-key": `m2m-unprov-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(403);
        await assertZeroBookingStateChange(hold.bookingId, hold.initialTokenHash, hold.initialJti);
      });

      it("accepts valid RS256 provisioned human JWT and returns 200", async () => {
        const buyerJwt = await signJwt({
          sub: buyerSub,
          email: "buyer.rs256@example.com",
          scope: "booking:prepare booking:commit",
          "https://velvetai.com/role_version": 1,
        });
        const hold = await prepareHold(buyerJwt);

        const res = await app.inject({
          method: "POST",
          url: `/v1/booking-approvals/${hold.locator}/${action}`,
          headers: {
            authorization: `Bearer ${buyerJwt}`,
            "idempotency-key": `valid-${crypto.randomUUID()}`,
          },
          payload: {},
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        if (action === "confirm") {
          expect(body.confirmation).toMatch(/^conf_/);
        } else {
          expect(body.status).toBe("COMMITTING");
        }
      });
    });
  }

  it("GET /v1/booking-approvals/:locator exposes non-PII bookingStatus, paymentStatus, paymentExpiresAt, and operationId after approve-and-commit", async () => {
    const buyerJwt = await signJwt({
      sub: buyerSub,
      email: "buyer.rs256@example.com",
      scope: "booking:prepare booking:commit booking:read",
      "https://velvetai.com/role_version": 1,
    });
    const hold = await prepareHold(buyerJwt);

    const commitRes = await app.inject({
      method: "POST",
      url: `/v1/booking-approvals/${hold.locator}/approve-and-commit`,
      headers: {
        authorization: `Bearer ${buyerJwt}`,
        "idempotency-key": `commit-status-${crypto.randomUUID()}`,
      },
      payload: {},
    });
    expect(commitRes.statusCode).toBe(200);

    // 1. After approve-and-commit: GET exposes status=CONSUMED, bookingStatus=COMMITTING, paymentExpiresAt, no PII
    const midPayGet = await app.inject({
      method: "GET",
      url: `/v1/booking-approvals/${hold.locator}`,
    });
    expect(midPayGet.statusCode).toBe(200);
    const midPayBody = midPayGet.json();
    expect(midPayBody.status).toBe("CONSUMED");
    expect(midPayBody.bookingStatus).toBe("COMMITTING");
    expect(typeof midPayBody.paymentExpiresAt).toBe("string");
    expect(Date.parse(midPayBody.paymentExpiresAt)).toBeGreaterThan(Date.now());
    expect(midPayGet.body).not.toContain("buyer.rs256@example.com");

    // 2. When payment intent + uncertain capture operation exist, GET exposes paymentStatus & operationId
    const opId = crypto.randomUUID();
    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .updateTable("bookings")
        .set({ status: "CAPTURE_UNCERTAIN" })
        .where("id", "=", hold.bookingId)
        .execute();

      await trx
        .insertInto("payment_intents")
        .values({
          id: crypto.randomUUID(),
          tenant_id: DEV_TENANT_ID,
          booking_id: hold.bookingId,
          provider_connection_id: null,
          provider_order_id: `PAYPAL_TEST_${crypto.randomUUID()}`,
          amount_minor: "2000",
          currency: "USD",
          state: "CAPTURE_IN_FLIGHT",
          payment_expires_at: new Date(Date.now() + 300_000),
          request_id: `req_${crypto.randomUUID()}`,
        })
        .execute();

      await trx
        .insertInto("provider_operations")
        .values({
          id: opId,
          tenant_id: DEV_TENANT_ID,
          booking_id: hold.bookingId,
          provider: "PAYPAL",
          environment: "sandbox",
          operation_type: "CAPTURE",
          state: "PENDING",
          endpoint: "/v2/checkout/orders/capture",
          paypal_request_id: `pp_${crypto.randomUUID()}`,
          canonical_payload_hash: "a".repeat(64),
          provider_order_id: null,
          provider_capture_id: null,
          provider_refund_id: null,
          last_http_status: null,
          provider_debug_id: null,
          error_code: null,
        })
        .execute();
    });

    const uncertainGet = await app.inject({
      method: "GET",
      url: `/v1/booking-approvals/${hold.locator}`,
    });
    expect(uncertainGet.statusCode).toBe(200);
    const uncertainBody = uncertainGet.json();
    expect(uncertainBody.bookingStatus).toBe("CAPTURE_UNCERTAIN");
    expect(uncertainBody.paymentStatus).toBe("CAPTURE_IN_FLIGHT");
    expect(uncertainBody.operationId).toBe(opId);
  });
});
