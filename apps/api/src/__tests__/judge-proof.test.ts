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

const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";
const DEV_TENANT_ID = "01932b10-0000-7000-8000-000000000001";

function collectAllKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAllKeys(item, keys);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      collectAllKeys(v, keys);
    }
  }
  return keys;
}

describe("WP 08 Part B: GET /v1/judge/bookings/:bookingId/proof", () => {
  let db: Kysely<Database>;
  let app: FastifyInstance;
  let keyPair: jose.GenerateKeyPairResult;
  const issuer = "https://auth0.velvetai.test/";
  const audience = "https://velvetai.example/api";

  const judgeUserId = crypto.randomUUID();
  const judgeSubject = `auth0|judge-proof-${Date.now()}`;
  const buyerUserId = crypto.randomUUID();
  const buyerSubject = `auth0|buyer-proof-${Date.now()}`;
  const m2mUserId = crypto.randomUUID();
  const m2mSubject = `proof-m2m-${Date.now()}@clients`;

  const judgeBookingId = crypto.randomUUID();
  const devBookingId = crypto.randomUUID();
  const devLocId = crypto.randomUUID();
  const devSvcId = crypto.randomUUID();
  const devSvId = crypto.randomUUID();
  const devResId = crypto.randomUUID();
  const devCustId = crypto.randomUUID();
  const devQuoteId = crypto.randomUUID();

  async function signJwt(sub: string, scope: string): Promise<string> {
    return new jose.SignJWT({ sub, scope })
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

    await db
      .insertInto("app_users")
      .values([
        {
          id: judgeUserId,
          oidc_subject: judgeSubject,
          email_ciphertext: "judge-proof@velvetai.local",
        },
        {
          id: buyerUserId,
          oidc_subject: buyerSubject,
          email_ciphertext: "buyer-proof@velvetai.local",
        },
        {
          id: m2mUserId,
          oidc_subject: m2mSubject,
          email_ciphertext: "m2m-proof@velvetai.local",
        },
      ])
      .execute();

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

      const sv = await trx
        .selectFrom("service_versions")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .select(["id", "cancellation_policy_id"])
        .executeTakeFirstOrThrow();

      // Dedicated per-run location & resource so repeated test runs never collide on GiST
      const locationId = crypto.randomUUID();
      await trx
        .insertInto("locations")
        .values({
          id: locationId,
          tenant_id: JUDGE_TENANT_ID,
          name: `Proof Route Loc ${judgeBookingId.slice(0, 8)}`,
          timezone: "UTC",
          status: "ACTIVE",
        })
        .execute();

      const resource = { id: crypto.randomUUID() };
      await trx
        .insertInto("resources")
        .values({
          id: resource.id,
          tenant_id: JUDGE_TENANT_ID,
          location_id: locationId,
          resource_type: "CHAIR",
          display_name: `Proof Route Chair ${judgeBookingId.slice(0, 8)}`,
          status: "ACTIVE",
        })
        .execute();

      const customerId = crypto.randomUUID();
      await trx
        .insertInto("customers")
        .values({
          id: customerId,
          tenant_id: JUDGE_TENANT_ID,
          email_ciphertext: "proof-route-pii@example.com",
          display_name_ciphertext: "Route PII Buyer",
          status: "ACTIVE",
        })
        .execute();

      const quoteId = crypto.randomUUID();
      const start = new Date("2027-09-12T10:00:00.000Z");
      const end = new Date("2027-09-12T11:00:00.000Z");
      const holdExp = new Date(Date.now() + 300_000);
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: JUDGE_TENANT_ID,
          service_version_id: sv.id,
          customer_id: customerId,
          starts_at: start,
          ends_at: end,
          total_minor: "7500",
          deposit_minor: "2000",
          currency: "USD",
          canonical_hash: "qhash",
          expires_at: holdExp,
        })
        .execute();

      await trx
        .insertInto("bookings")
        .values({
          id: judgeBookingId,
          tenant_id: JUDGE_TENANT_ID,
          customer_id: customerId,
          quote_id: quoteId,
          status: "CONFIRMED",
          version: 3,
          hold_expires_at: holdExp,
          starts_at: start,
          ends_at: end,
          resource_id: resource.id,
        })
        .execute();

      await trx
        .insertInto("resource_claims")
        .values({
          id: crypto.randomUUID(),
          tenant_id: JUDGE_TENANT_ID,
          booking_id: judgeBookingId,
          claim_source: "BOOKING",
          resource_id: resource.id,
          starts_at: start,
          ends_at: end,
          blocked_during: sql`tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)')`,
          blocking: true,
          state: "CONFIRMED",
        })
        .execute();

      const piId = crypto.randomUUID();
      await trx
        .insertInto("payment_intents")
        .values({
          id: piId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: judgeBookingId,
          provider_connection_id: null,
          provider_order_id: `88XYORDER${judgeBookingId.slice(0, 8)}AB12`,
          amount_minor: "2000",
          currency: "USD",
          state: "CAPTURED",
          payment_expires_at: holdExp,
          request_id: `req-${judgeBookingId}`,
        })
        .execute();

      const capId = crypto.randomUUID();
      await trx
        .insertInto("payment_captures")
        .values({
          id: capId,
          tenant_id: JUDGE_TENANT_ID,
          payment_intent_id: piId,
          booking_id: judgeBookingId,
          provider_capture_id: `55ZPCAPTURE${judgeBookingId.slice(0, 8)}XY99`,
          amount_minor: "2000",
          currency: "USD",
          state: "COMPLETED",
          captured_at: new Date(),
        })
        .execute();

      const entryId = crypto.randomUUID();
      await trx
        .insertInto("financial_journal_entries")
        .values({
          id: entryId,
          tenant_id: JUDGE_TENANT_ID,
          booking_id: judgeBookingId,
          entry_type: "DEPOSIT_CAPTURE",
          reference_id: capId,
          currency: "USD",
          status: "DRAFT",
          posted_at: null,
        })
        .execute();

      await trx
        .insertInto("financial_journal_lines")
        .values([
          {
            id: crypto.randomUUID(),
            journal_entry_id: entryId,
            tenant_id: JUDGE_TENANT_ID,
            account: "ASSET:PAYPAL_CLEARING",
            debit_minor: "2000",
            credit_minor: "0",
            currency: "USD",
          },
          {
            id: crypto.randomUUID(),
            journal_entry_id: entryId,
            tenant_id: JUDGE_TENANT_ID,
            account: "LIABILITY:CUSTOMER_DEPOSIT",
            debit_minor: "0",
            credit_minor: "2000",
            currency: "USD",
          },
        ])
        .execute();

      await trx
        .updateTable("financial_journal_entries")
        .set({ status: "POSTED", posted_at: new Date() })
        .where("id", "=", entryId)
        .execute();
    });

    // Seed an isolated booking inside DEV_TENANT_ID to verify 404 cross-tenant isolation
    const devTenantExists = await db
      .selectFrom("tenants")
      .where("id", "=", DEV_TENANT_ID)
      .select("id")
      .executeTakeFirst();
    if (!devTenantExists) {
      await db
        .insertInto("tenants")
        .values({
          id: DEV_TENANT_ID,
          name: "Synthetic Dev",
          default_currency: "USD",
          status: "ACTIVE",
        })
        .execute();
    }

    await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: devLocId,
          tenant_id: DEV_TENANT_ID,
          name: `Dev Loc ${devBookingId.slice(0, 8)}`,
          timezone: "UTC",
          status: "ACTIVE",
        })
        .execute();
      await trx
        .insertInto("services")
        .values({
          id: devSvcId,
          tenant_id: DEV_TENANT_ID,
          status: "ACTIVE",
          current_version_id: null,
        })
        .execute();
      await trx
        .insertInto("service_versions")
        .values({
          id: devSvId,
          tenant_id: DEV_TENANT_ID,
          service_id: devSvcId,
          version: 1,
          name: "Dev Svc",
          description: null,
          duration_minutes: 30,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "5000",
          base_deposit_minor: "1000",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .execute();
      await trx
        .insertInto("resources")
        .values({
          id: devResId,
          tenant_id: DEV_TENANT_ID,
          location_id: devLocId,
          resource_type: "CHAIR",
          display_name: "Dev Chair",
          status: "ACTIVE",
        })
        .execute();
      await trx
        .insertInto("customers")
        .values({
          id: devCustId,
          tenant_id: DEV_TENANT_ID,
          email_ciphertext: "dev-tenant@example.com",
          display_name_ciphertext: "Dev Buyer",
          status: "ACTIVE",
        })
        .execute();
      const s = new Date("2027-09-13T10:00:00.000Z");
      const e = new Date("2027-09-13T10:30:00.000Z");
      await trx
        .insertInto("booking_quotes")
        .values({
          id: devQuoteId,
          tenant_id: DEV_TENANT_ID,
          service_version_id: devSvId,
          customer_id: devCustId,
          starts_at: s,
          ends_at: e,
          total_minor: "5000",
          deposit_minor: "1000",
          currency: "USD",
          canonical_hash: "dq",
          expires_at: new Date(Date.now() + 300_000),
        })
        .execute();
      await trx
        .insertInto("bookings")
        .values({
          id: devBookingId,
          tenant_id: DEV_TENANT_ID,
          customer_id: devCustId,
          quote_id: devQuoteId,
          status: "CONFIRMED",
          version: 1,
          hold_expires_at: null,
          starts_at: s,
          ends_at: e,
          resource_id: devResId,
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
      await withTenantTransaction(db, DEV_TENANT_ID, async (trx) => {
        await trx.deleteFrom("bookings").where("id", "=", devBookingId).execute();
        await trx.deleteFrom("booking_quotes").where("id", "=", devQuoteId).execute();
        await trx.deleteFrom("customers").where("id", "=", devCustId).execute();
        await trx.deleteFrom("resources").where("id", "=", devResId).execute();
        await trx.deleteFrom("service_versions").where("id", "=", devSvId).execute();
        await trx.deleteFrom("services").where("id", "=", devSvcId).execute();
        await trx.deleteFrom("locations").where("id", "=", devLocId).execute();
      });
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx.deleteFrom("judge_runs").where("requested_by", "=", judgeUserId).execute();
        await trx
          .deleteFrom("memberships")
          .where("user_id", "in", [judgeUserId, buyerUserId, m2mUserId])
          .execute();
      });
    } finally {
      if (app) {
        await app.close();
      }
      if (db) {
        await db.destroy();
      }
    }
  });

  it("enforces 401/403 non-judge/M2M rejection and returns 404 for dev-tenant booking IDs", async () => {
    const unauth = await app.inject({
      method: "GET",
      url: `/v1/judge/bookings/${judgeBookingId}/proof`,
    });
    expect(unauth.statusCode).toBe(401);

    const buyerJwt = await signJwt(buyerSubject, "booking:read");
    const buyerRes = await app.inject({
      method: "GET",
      url: `/v1/judge/bookings/${judgeBookingId}/proof`,
      headers: { authorization: `Bearer ${buyerJwt}` },
    });
    expect(buyerRes.statusCode).toBe(403);
    expect(JSON.parse(buyerRes.body).code).toBe("insufficient_scope");

    const m2mJwt = await signJwt(m2mSubject, "judge:proof booking:read");
    const m2mRes = await app.inject({
      method: "GET",
      url: `/v1/judge/bookings/${judgeBookingId}/proof`,
      headers: { authorization: `Bearer ${m2mJwt}` },
    });
    expect(m2mRes.statusCode).toBe(403);
    expect(JSON.parse(m2mRes.body).code).toBe("HUMAN_JUDGE_REQUIRED");

    const judgeJwt = await signJwt(judgeSubject, "openid profile email booking:read");
    const devRes = await app.inject({
      method: "GET",
      url: `/v1/judge/bookings/${devBookingId}/proof`,
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(devRes.statusCode).toBe(404);

    const invalidRes = await app.inject({
      method: "GET",
      url: "/v1/judge/bookings/not-a-uuid/proof",
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(invalidRes.statusCode).toBe(400);
  });

  it("returns masked technical proof with balanced ledger and zero secret/PII fields for confirmed judge booking", async () => {
    const judgeJwt = await signJwt(judgeSubject, "openid profile email booking:read");
    const res = await app.inject({
      method: "GET",
      url: `/v1/judge/bookings/${judgeBookingId}/proof`,
      headers: { authorization: `Bearer ${judgeJwt}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.bookingId).toBe(judgeBookingId);
    expect(body.status).toBe("CONFIRMED");
    expect(body.paypal).toEqual({
      environment: "sandbox",
      orderIdMasked: "88XY…AB12",
      captureIdMasked: "55ZP…XY99",
      captureStatus: "COMPLETED",
    });
    expect(body.ledger).toEqual({
      entries: 1,
      balanced: true,
      depositLiabilityMinor: "2000",
      currency: "USD",
    });
    expect(body.counts).toEqual({
      captures: 1,
      bookingsForHold: 1,
      journalEntriesForCapture: 1,
    });

    const keys = collectAllKeys(body);
    for (const k of keys) {
      expect(k).not.toMatch(/(token|secret|note|email|password)/i);
    }
    expect(res.body).not.toContain(`88XYORDER${judgeBookingId.slice(0, 8)}AB12`);
    expect(res.body).not.toContain(`55ZPCAPTURE${judgeBookingId.slice(0, 8)}XY99`);
    expect(res.body).not.toContain("proof-route-pii@example.com");
  });
});
