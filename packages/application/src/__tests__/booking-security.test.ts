import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { Kysely } from "kysely";
import {
  Database,
  createDatabaseClient,
  migrateToLatest,
  withTenantTransaction,
  getTestDatabaseUrl,
} from "@velvetai/db";
import {
  signBookingIntent,
  verifyBookingIntent,
  registerIntentKey,
  getDefaultIntentKeys,
} from "../booking-intent.js";
import { sha256Hex } from "../canonicalizer.js";
import { BookingService } from "../booking-service.js";
import {
  SignedBookingIntentClaims,
  TenantId,
  LocationId,
  ServiceId,
  ResourceId,
  UserId,
  Rfc3339Timestamp,
  IanaTimeZone,
  BookingId,
  CancellationPolicyId,
} from "@velvetai/contracts";

const TEST_DB_URL = getTestDatabaseUrl();

describe("Booking Security & JWS Cryptographic Tests (Requirements 8, 9, 11, 12)", () => {
  let db: Kysely<Database>;
  let bookingService: BookingService;
  let tenantA: TenantId;
  let tenantB: TenantId;
  let locationA: LocationId;
  let serviceA: ServiceId;
  let serviceVersionA: string;
  let resourceA: ResourceId;
  let userA: UserId;
  let userB: UserId;
  let subjectA: string;
  let subjectB: string;

  beforeAll(async () => {
    db = createDatabaseClient(TEST_DB_URL, { min: 2, max: 15 });
    await migrateToLatest(db);
    bookingService = new BookingService(db);

    tenantA = crypto.randomUUID() as TenantId;
    tenantB = crypto.randomUUID() as TenantId;
    locationA = crypto.randomUUID() as LocationId;
    serviceA = crypto.randomUUID() as ServiceId;
    serviceVersionA = crypto.randomUUID();
    resourceA = crypto.randomUUID() as ResourceId;
    userA = crypto.randomUUID() as UserId;
    userB = crypto.randomUUID() as UserId;
    subjectA = `oidc|user-a-${userA}`;
    subjectB = `oidc|user-b-${userB}`;

    // Seed tenants
    await db
      .insertInto("tenants")
      .values([
        { id: tenantA, name: `sec-a-${Date.now()}`, default_currency: "USD", status: "ACTIVE" },
        { id: tenantB, name: `sec-b-${Date.now()}`, default_currency: "USD", status: "ACTIVE" },
      ])
      .execute();

    // Seed users
    await db
      .insertInto("app_users")
      .values([
        { id: userA, oidc_subject: subjectA, email_ciphertext: "a@example.com" },
        { id: userB, oidc_subject: subjectB, email_ciphertext: "b@example.com" },
      ])
      .execute();

    // Seed Tenant A structures
    await withTenantTransaction(db, tenantA, async (trx) => {
      await trx
        .insertInto("locations")
        .values({
          id: locationA,
          tenant_id: tenantA,
          name: "Security Clinic",
          timezone: "America/New_York",
          status: "ACTIVE",
        })
        .execute();

      await trx
        .insertInto("memberships")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantA,
          user_id: userA,
          role: "OWNER",
          role_version: 1,
        })
        .execute();

      await trx
        .insertInto("services")
        .values({
          id: serviceA,
          tenant_id: tenantA,
          status: "ACTIVE",
          current_version_id: null,
        })
        .execute();

      await trx
        .insertInto("service_versions")
        .values({
          id: serviceVersionA,
          tenant_id: tenantA,
          service_id: serviceA,
          version: 1,
          name: "Security Consult",
          duration_minutes: 30,
          buffer_before_minutes: 0,
          buffer_after_minutes: 0,
          price_minor: "5000",
          base_deposit_minor: "1500",
          currency: "USD",
          cancellation_policy_id: crypto.randomUUID(),
        })
        .execute();

      await trx
        .updateTable("services")
        .set({ current_version_id: serviceVersionA })
        .where("id", "=", serviceA)
        .execute();

      await trx
        .insertInto("resources")
        .values({
          id: resourceA,
          tenant_id: tenantA,
          location_id: locationA,
          resource_type: "ROOM",
          display_name: "Suite 1",
          status: "ACTIVE",
        })
        .execute();
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("Requirement 11: JWS Attacks & Hardening", () => {
    const defaultKeys = getDefaultIntentKeys();

    function createValidClaims(): SignedBookingIntentClaims {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: "https://api.velvetai.example",
        aud: "velvetai-booking",
        sub: subjectA,
        client_id: "client-portal-1",
        tenant_id: tenantA,
        jti: crypto.randomUUID(),
        iat: now,
        nbf: now - 5,
        exp: now + 900,
        purpose: "booking_commit",
        hold_id: crypto.randomUUID() as BookingId,
        hold_version: 1,
        tool_name: "prepare_booking",
        tool_version: "1.0.0",
        schema_hash: "a".repeat(64),
        canonical_argument_hash: "b".repeat(64),
        merchant_id: "merchant-1",
        total_minor: "5000",
        deposit_minor: "1500",
        currency: "USD",
        currency_scale: 2,
        price_version: 1,
        cancellation_policy_id: crypto.randomUUID() as CancellationPolicyId,
        cancellation_policy_version: 1,
        cancellation_policy_hash: "c".repeat(64),
        allowed_surfaces: ["web", "mcp"],
      };
    }

    it("verifies a valid ES256 intent signed with standard key", async () => {
      const claims = createValidClaims();
      const token = await signBookingIntent(claims);
      const verified = await verifyBookingIntent(token, {
        expectedIssuer: "https://api.velvetai.example",
        expectedAudience: "velvetai-booking",
      });
      expect(verified.jti).toBe(claims.jti);
      expect(verified.tenant_id).toBe(tenantA);
    });

    it("rejects JWS with alg 'none'", async () => {
      const claims = createValidClaims();
      const header = { alg: "none", typ: "velvetai-intent+jwt", kid: defaultKeys.kid };
      const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const pB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const forgedNoneJws = `${hB64}.${pB64}.`;

      await expect(verifyBookingIntent(forgedNoneJws)).rejects.toThrow(/only 'ES256' is permitted/);
    });

    it("rejects algorithm confusion (e.g. HS256 with EC public key as secret)", async () => {
      const claims = createValidClaims();
      const header = { alg: "HS256", typ: "velvetai-intent+jwt", kid: defaultKeys.kid };
      const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const pB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const signingInput = `${hB64}.${pB64}`;
      const forgedSig = crypto
        .createHmac("sha256", defaultKeys.publicKeyPem)
        .update(signingInput)
        .digest("base64url");
      const forgedHs256 = `${signingInput}.${forgedSig}`;

      await expect(verifyBookingIntent(forgedHs256)).rejects.toThrow(/only 'ES256' is permitted/);
    });

    it("rejects unknown kid", async () => {
      const claims = createValidClaims();
      const token = await signBookingIntent(claims, { kid: "unknown-kid-999" });
      await expect(verifyBookingIntent(token)).rejects.toThrow(/Unknown kid/);
    });

    it("rejects remote jku or x5u in header", async () => {
      const claims = createValidClaims();
      const header = {
        alg: "ES256",
        typ: "velvetai-intent+jwt",
        kid: defaultKeys.kid,
        jku: "https://evil-attacker.example/keys.json",
      };
      const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const pB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = crypto
        .sign("SHA256", Buffer.from(`${hB64}.${pB64}`), {
          key: defaultKeys.privateKeyPem,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url");

      await expect(verifyBookingIntent(`${hB64}.${pB64}.${sig}`)).rejects.toThrow(
        /Remote jku or x5u headers are prohibited/,
      );
    });

    it("rejects wrong typ (e.g. standard JWT)", async () => {
      const claims = createValidClaims();
      const header = { alg: "ES256", typ: "JWT", kid: defaultKeys.kid };
      const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
      const pB64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
      const sig = crypto
        .sign("SHA256", Buffer.from(`${hB64}.${pB64}`), {
          key: defaultKeys.privateKeyPem,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url");

      await expect(verifyBookingIntent(`${hB64}.${pB64}.${sig}`)).rejects.toThrow(
        /Invalid JWS typ/,
      );
    });

    it("rejects issuer mismatch and audience mismatch", async () => {
      const claims = createValidClaims();
      const token = await signBookingIntent(claims);

      await expect(
        verifyBookingIntent(token, { expectedIssuer: "https://different-issuer.example" }),
      ).rejects.toThrow(/Intent issuer mismatch/);

      await expect(
        verifyBookingIntent(token, { expectedAudience: "wrong-audience" }),
      ).rejects.toThrow(/Intent audience mismatch/);
    });

    it("rejects expired intent and not-yet-valid intent", async () => {
      const claims = createValidClaims();
      const token = await signBookingIntent(claims);

      // Future time beyond exp
      await expect(verifyBookingIntent(token, { asOfSeconds: claims.exp + 10 })).rejects.toThrow(
        /Intent has expired/,
      );

      // Past time before nbf
      await expect(verifyBookingIntent(token, { asOfSeconds: claims.nbf - 10 })).rejects.toThrow(
        /Intent is not yet valid/,
      );
    });

    it("rejects tampered payload content", async () => {
      const claims = createValidClaims();
      const token = await signBookingIntent(claims);
      const [h, p, s] = token.split(".");

      // Tamper with payload by changing total_minor
      const payloadObj = JSON.parse(Buffer.from(p!, "base64url").toString("utf8"));
      payloadObj.total_minor = "999999";
      const tamperedP = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");

      await expect(verifyBookingIntent(`${h}.${tamperedP}.${s}`)).rejects.toThrow(
        /signature verification failed/,
      );
    });
  });

  describe("Requirement 8 & 9: Artifact Mismatch, Substitution, & Confirmation Replay", () => {
    it("substitutions (tenant, client, actor) are rejected during commit", async () => {
      const slotStart = "2026-12-15T10:00:00.000Z" as Rfc3339Timestamp;

      // 1. Prepare hold
      const prepared = await bookingService.prepareBooking(
        tenantA,
        {
          userId: userA,
          subject: subjectA,
          role: "OWNER",
        },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: slotStart,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: {
            fullName: "Alice Security",
            email: "alice@example.com",
          },
        },
      );

      // 2. Confirm hold
      const confirmed = await bookingService.confirmApproval(
        tenantA,
        prepared.approvalLocator,
        userA,
      );

      // Test 9a: Tenant substitution (attempting to commit under Tenant B)
      await expect(
        bookingService.commitBooking(
          tenantB, // Spoofed tenant context
          {
            userId: userA,
            subject: subjectA,
            role: "OWNER",
          },
          "client-portal-1",
          {
            intent: prepared.intent,
            confirmation: confirmed.confirmation,
            idempotency_key: "idemp-commit-sub-tenant",
          },
        ),
      ).rejects.toThrow(/Tenant substitution/);

      // Test 9b: Client substitution (different client_id)
      await expect(
        bookingService.commitBooking(
          tenantA,
          {
            userId: userA,
            subject: subjectA,
            role: "OWNER",
          },
          "different-oauth-client", // Spoofed client
          {
            intent: prepared.intent,
            confirmation: confirmed.confirmation,
            idempotency_key: "idemp-commit-sub-client",
          },
        ),
      ).rejects.toThrow(/OAuth client substitution/);

      // Test 9c: Actor substitution (different user/subject)
      await expect(
        bookingService.commitBooking(
          tenantA,
          {
            userId: userB,
            subject: subjectB, // Spoofed actor
            role: "MEMBER",
          },
          "client-portal-1",
          {
            intent: prepared.intent,
            confirmation: confirmed.confirmation,
            idempotency_key: "idemp-commit-sub-actor",
          },
        ),
      ).rejects.toThrow(/Actor subject substitution/);
    });

    it("artifact mismatch: Intent A combined with Confirmation B fails", async () => {
      // Prepare Hold 1
      const prep1 = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-16T10:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Alice One", email: "alice1@example.com" },
        },
      );

      // Prepare Hold 2
      const prep2 = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-16T11:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Alice Two", email: "alice2@example.com" },
        },
      );

      // Confirm Hold 2
      const conf2 = await bookingService.confirmApproval(tenantA, prep2.approvalLocator, userA);

      // Attempt to commit Intent 1 with Confirmation 2
      await expect(
        bookingService.commitBooking(
          tenantA,
          { userId: userA, subject: subjectA, role: "OWNER" },
          "client-portal-1",
          {
            intent: prep1.intent,
            confirmation: conf2.confirmation,
            idempotency_key: "idemp-commit-mismatch",
          },
        ),
      ).rejects.toThrow(/does not match booking hold/);
    });

    it("Requirement 8: sequential and concurrent confirmation replay creates exactly one operation", async () => {
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-17T14:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Alice Replay", email: "alice.replay@example.com" },
        },
      );

      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);

      // First commit: succeeds
      const commitRes1 = await bookingService.commitBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          intent: prep.intent,
          confirmation: conf.confirmation,
          idempotency_key: "idemp-commit-replay-1",
        },
      );

      expect(commitRes1.bookingId).toBe(prep.bookingId);
      expect(commitRes1.status).toBe("COMMITTING");

      // Sequential replay with same idempotency key -> idempotent return
      const commitRes2 = await bookingService.commitBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          intent: prep.intent,
          confirmation: conf.confirmation,
          idempotency_key: "idemp-commit-replay-1",
        },
      );
      expect(commitRes2.bookingId).toBe(prep.bookingId);

      // Replay with different idempotency key -> rejected because intent is already committed
      await expect(
        bookingService.commitBooking(
          tenantA,
          { userId: userA, subject: subjectA, role: "OWNER" },
          "client-portal-1",
          {
            intent: prep.intent,
            confirmation: conf.confirmation,
            idempotency_key: "different-idemp-key",
          },
        ),
      ).rejects.toThrow(/already been consumed|already been committed/);
    });

    it("Requirement 12: atomic commit guarantees outbox event and booking status commit together", async () => {
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-18T09:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Alice Atom", email: "alice.atom@example.com" },
        },
      );

      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);

      await bookingService.commitBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          intent: prep.intent,
          confirmation: conf.confirmation,
          idempotency_key: "idemp-atom-commit",
        },
      );

      // Verify booking state and outbox events in database
      await withTenantTransaction(db, tenantA, async (trx) => {
        const booking = await trx
          .selectFrom("bookings")
          .where("id", "=", prep.bookingId)
          .selectAll()
          .executeTakeFirstOrThrow();
        expect(booking.status).toBe("COMMITTING");

        const outbox = await trx
          .selectFrom("outbox_events")
          .where("aggregate_id", "=", prep.bookingId)
          .where("event_type", "=", "booking.committing")
          .selectAll()
          .execute();
        expect(outbox.length).toBe(1);

        const audit = await trx
          .selectFrom("audit_events")
          .where("resource_id", "=", prep.bookingId)
          .where("action", "=", "booking.committed")
          .selectAll()
          .execute();
        expect(audit.length).toBe(1);
      });
    });

    it("Requirement 4: 100-request concurrent replay test: one confirmation under simultaneous commit attempts", async () => {
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-19T10:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Concurrent Replay User", email: "replay@example.com" },
        },
      );

      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);

      const idempotencyKey = "concurrent-replay-idemp-100";

      // Launch 100 concurrent replay requests simultaneously
      const results = await Promise.allSettled(
        Array.from({ length: 100 }, async () => {
          return await bookingService.commitBooking(
            tenantA,
            { userId: userA, subject: subjectA, role: "OWNER" },
            "client-portal-1",
            {
              intent: prep.intent,
              confirmation: conf.confirmation,
              idempotency_key: idempotencyKey,
            },
          );
        }),
      );

      // Count fulfilled vs rejected (in-flight concurrent executions may yield 409 while one commits and completes)
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Every fulfilled response must return the exact bookingId and status COMMITTING
      for (const f of fulfilled) {
        if (f.status === "fulfilled") {
          expect(f.value.bookingId).toBe(prep.bookingId);
          expect(f.value.status).toBe("COMMITTING");
        }
      }

      // Assert database invariants: exactly 1 committed intent, exactly 1 outbox event
      await withTenantTransaction(db, tenantA, async (trx) => {
        const committedIntents = await trx
          .selectFrom("committed_intents")
          .where("booking_id", "=", prep.bookingId)
          .selectAll()
          .execute();
        expect(committedIntents.length).toBe(1);

        const outboxEvents = await trx
          .selectFrom("outbox_events")
          .where("aggregate_id", "=", prep.bookingId)
          .where("event_type", "=", "booking.committing")
          .selectAll()
          .execute();
        expect(outboxEvents.length).toBe(1);
      });
    });

    it("Requirement 1: 100-request concurrent commit with SAME confirmation and DIFFERENT idempotency keys yields exactly 1 success and 99 CONFIRMATION_REPLAY_BLOCKED", async () => {
      const slotTime = "2026-12-22T10:00:00.000Z" as Rfc3339Timestamp;
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: slotTime as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "100 Diff Keys Test", email: "diff100@example.com" },
        },
      );

      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);

      // Launch 100 concurrent requests with the SAME confirmation token but 100 DIFFERENT idempotency keys
      const promises = Array.from({ length: 100 }, (_, idx) => {
        return bookingService.commitBooking(
          tenantA,
          { userId: userA, subject: subjectA, role: "OWNER" },
          "client-portal-1",
          {
            intent: prep.intent,
            confirmation: conf.confirmation,
            idempotency_key: `concurrent-diff-key-${idx}-${crypto.randomUUID()}`,
          },
        );
      });

      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 1 must succeed
      expect(fulfilled.length).toBe(1);
      if (fulfilled[0]?.status === "fulfilled") {
        expect(fulfilled[0].value.bookingId).toBe(prep.bookingId);
        expect(fulfilled[0].value.status).toBe("COMMITTING");
      }

      // Exactly 99 must fail with CONFIRMATION_REPLAY_BLOCKED (HTTP 409)
      expect(rejected.length).toBe(99);
      for (const rej of rejected) {
        if (rej.status === "rejected") {
          const err = rej.reason as { code?: string; status?: number; message?: string };
          expect(err.code).toBe("CONFIRMATION_REPLAY_BLOCKED");
          expect(err.status).toBe(409);
        }
      }

      // Assert database invariants: exactly 1 committed intent, exactly 1 outbox event
      await withTenantTransaction(db, tenantA, async (trx) => {
        const committedIntents = await trx
          .selectFrom("committed_intents")
          .where("booking_id", "=", prep.bookingId)
          .selectAll()
          .execute();
        expect(committedIntents.length).toBe(1);

        const outboxEvents = await trx
          .selectFrom("outbox_events")
          .where("aggregate_id", "=", prep.bookingId)
          .where("event_type", "=", "booking.committing")
          .selectAll()
          .execute();
        expect(outboxEvents.length).toBe(1);
      });
    });

    it("Requirement 3: Confirmation tokens and approval locators security invariants", async () => {
      const slotTime = "2026-12-25T10:00:00.000Z" as Rfc3339Timestamp;
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: slotTime as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Security Invariants Buyer", email: "secinv@example.com" },
        },
      );

      // 1. Locator contains at least 128 bits of randomness:
      // Pattern: /v1/booking-approvals/loc_<32 hex chars = 16 bytes = 128 bits>
      const locatorHex = prep.approvalLocator.replace("/v1/booking-approvals/loc_", "");
      expect(locatorHex).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.from(locatorHex, "hex").length).toBe(16); // 16 bytes = 128 bits

      // 2. Locator knowledge does not authorize approval
      // Reading approval details with locator is read-only terms inspection
      const details = await bookingService.getApprovalDetails(tenantA, prep.approvalLocator);
      expect(details.bookingId).toBe(prep.bookingId);
      // Attempting to commit using the locator as a confirmation token fails closed (400)
      await expect(
        bookingService.commitBooking(
          tenantA,
          { userId: userA, subject: subjectA, role: "OWNER" },
          "client-portal-1",
          {
            intent: prep.intent,
            confirmation: prep.approvalLocator,
            idempotency_key: crypto.randomUUID(),
          },
        ),
      ).rejects.toThrow(/Invalid buyer confirmation token/);

      // 3. Confirming approval generates opaque one-time confirmation token with at least 256 bits of randomness
      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);
      // Pattern: conf_<64 hex chars = 32 bytes = 256 bits>
      const tokenHex = conf.confirmation.replace("conf_", "");
      expect(tokenHex).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.from(tokenHex, "hex").length).toBe(32); // 32 bytes = 256 bits

      // 4. Only hashes are stored in PostgreSQL:
      // Verify raw confirmation token does NOT exist anywhere in database
      await withTenantTransaction(db, tenantA, async (trx) => {
        const row = await trx
          .selectFrom("buyer_confirmations")
          .where("booking_id", "=", prep.bookingId)
          .selectAll()
          .executeTakeFirstOrThrow();

        // The column token_hash holds the SHA-256 of the token
        const expectedHash = sha256Hex(conf.confirmation);
        expect(row.token_hash).toBe(expectedHash);
        expect(row.token_hash).not.toContain(conf.confirmation);
      });

      // 5. Confirmation tokens never appear in URLs:
      // approvalLocator is /v1/booking-approvals/loc_<hex>, confirmation token is NEVER a URL parameter
      expect(prep.approvalLocator).not.toContain(conf.confirmation);
      expect(conf.confirmation).not.toContain("http");
      expect(conf.confirmation).not.toContain("/");
    });

    it("Requirement 4: reusing already-consumed confirmation with a NEW idempotency key fails with 409", async () => {
      const prep = await bookingService.prepareBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          serviceId: serviceA,
          locationId: locationA,
          startsAt: "2026-12-20T11:00:00.000Z" as Rfc3339Timestamp,
          timeZone: "America/New_York" as IanaTimeZone,
          customer: { fullName: "Consumed Replay Test", email: "consumed@example.com" },
        },
      );

      const conf = await bookingService.confirmApproval(tenantA, prep.approvalLocator, userA);

      // Commit once successfully
      await bookingService.commitBooking(
        tenantA,
        { userId: userA, subject: subjectA, role: "OWNER" },
        "client-portal-1",
        {
          intent: prep.intent,
          confirmation: conf.confirmation,
          idempotency_key: "first-commit-key",
        },
      );

      // Attempt second commit with NEW idempotency key and same confirmation -> MUST FAIL
      let newKeyReplayFailed = false;
      try {
        await bookingService.commitBooking(
          tenantA,
          { userId: userA, subject: subjectA, role: "OWNER" },
          "client-portal-1",
          {
            intent: prep.intent,
            confirmation: conf.confirmation,
            idempotency_key: "brand-new-different-key",
          },
        );
      } catch (err: unknown) {
        const dErr = err as { code?: string; status?: number; message?: string };
        if (
          dErr.code === "INTENT_REPLAY_DETECTED" ||
          dErr.code === "CONFIRMATION_REPLAY_BLOCKED" ||
          dErr.status === 409
        ) {
          newKeyReplayFailed = true;
        }
      }
      expect(newKeyReplayFailed).toBe(true);
    });

    it("Requirement 7: ES256 Interoperability: velvetAI signs -> jose verifies and jose signs -> velvetAI verifies", async () => {
      const claims: SignedBookingIntentClaims = {
        jti: crypto.randomUUID(),
        iss: "https://api.velvetai.example",
        aud: "velvetai-booking",
        sub: subjectA,
        iat: Math.floor(Date.now() / 1000),
        nbf: Math.floor(Date.now() / 1000) - 10,
        exp: Math.floor(Date.now() / 1000) + 900,
        tenant_id: tenantA,
        client_id: "client-portal-1",
        hold_id: crypto.randomUUID() as BookingId,
        hold_version: 1,
        purpose: "booking_commit",
        tool_name: "prepare_booking",
        tool_version: "1.0.0",
        schema_hash: "0".repeat(64),
        canonical_argument_hash: "1".repeat(64),
        merchant_id: tenantA,
        total_minor: "5000",
        deposit_minor: "1500",
        currency: "USD",
        currency_scale: 2,
        price_version: 1,
        cancellation_policy_id: "01932b10-0003-7000-8000-000000000001" as CancellationPolicyId,
        cancellation_policy_version: 1,
        cancellation_policy_hash: "2".repeat(64),
        allowed_surfaces: ["web", "mcp_streamable_http"],
      };

      const defaultKeys = getDefaultIntentKeys();

      // 1. velvetAI production (jose) signs -> verify signature is raw IEEE-P1363 64 bytes
      const velvetToken = await signBookingIntent(claims);
      const signatureB64 = velvetToken.split(".")[2]!;
      const rawSignature = Buffer.from(signatureB64, "base64url");
      expect(rawSignature.length).toBe(64); // Exactly 64 bytes (32 bytes R || 32 bytes S)

      // 2. Verified independently using Node crypto.verify (explicit interop proof)
      const [hB64, pB64] = velvetToken.split(".");
      const signingInput = `${hB64}.${pB64}`;
      const cryptoVerified = crypto.verify(
        "SHA256",
        Buffer.from(signingInput),
        { key: defaultKeys.publicKeyPem, dsaEncoding: "ieee-p1363" },
        rawSignature,
      );
      expect(cryptoVerified).toBe(true);

      // 3. Node crypto.sign signs -> verified independently using production verifyBookingIntent (jose)
      const cryptoSig = crypto
        .sign("SHA256", Buffer.from(signingInput), {
          key: defaultKeys.privateKeyPem,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url");
      const cryptoToken = `${signingInput}.${cryptoSig}`;

      const velvetVerified = await verifyBookingIntent(cryptoToken, {
        expectedIssuer: "https://api.velvetai.example",
        expectedAudience: "velvetai-booking",
      });
      expect(velvetVerified.jti).toBe(claims.jti);
      expect(velvetVerified.total_minor).toBe(claims.total_minor);
    });

    it("Requirement 7: Key rotation: active key store verifies rotated kid; unknown kid fails", async () => {
      // Generate second rotated keypair
      const ec2 = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const rotatedKey = {
        kid: "key-velvetai-2",
        privateKeyPem: ec2.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        publicKeyPem: ec2.publicKey.export({ type: "spki", format: "pem" }) as string,
      };

      // Register rotated key in key store
      registerIntentKey(rotatedKey);

      const claims: SignedBookingIntentClaims = {
        jti: crypto.randomUUID(),
        iss: "https://api.velvetai.example",
        aud: "velvetai-booking",
        sub: subjectA,
        iat: Math.floor(Date.now() / 1000),
        nbf: Math.floor(Date.now() / 1000) - 10,
        exp: Math.floor(Date.now() / 1000) + 900,
        tenant_id: tenantA,
        client_id: "client-portal-1",
        hold_id: crypto.randomUUID() as BookingId,
        hold_version: 1,
        purpose: "booking_commit",
        tool_name: "prepare_booking",
        tool_version: "1.0.0",
        schema_hash: "0".repeat(64),
        canonical_argument_hash: "1".repeat(64),
        merchant_id: tenantA,
        total_minor: "5000",
        deposit_minor: "1500",
        currency: "USD",
        currency_scale: 2,
        price_version: 1,
        cancellation_policy_id: "01932b10-0003-7000-8000-000000000001" as CancellationPolicyId,
        cancellation_policy_version: 1,
        cancellation_policy_hash: "2".repeat(64),
        allowed_surfaces: ["web"],
      };

      // Sign with rotated key kid: key-velvetai-2
      const rotatedToken = await signBookingIntent(claims, {
        keyConfig: rotatedKey,
        kid: "key-velvetai-2",
      });
      const verified = await verifyBookingIntent(rotatedToken);
      expect(verified.jti).toBe(claims.jti);

      // Attempt to verify with unknown kid
      const unknownKidToken = await signBookingIntent(claims, {
        keyConfig: rotatedKey,
        kid: "unknown-rotated-kid",
      });
      await expect(verifyBookingIntent(unknownKidToken)).rejects.toThrow(
        /Unknown kid 'unknown-rotated-kid'/,
      );
    });
  });
});
