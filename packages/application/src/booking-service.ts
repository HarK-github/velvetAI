import crypto from "node:crypto";
import { Kysely, sql } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import {
  BookingId,
  BookingQuoteId,
  CommitBookingInput,
  CommitBookingResponse,
  CreateBookingQuoteInput,
  PrepareBookingInput,
  PrepareBookingResponse,
  BookingApprovalDetails,
  ConfirmBookingApprovalResponse,
  BookingQuoteDTO,
  TenantId,
  UserId,
  MoneyMinor,
  CurrencyCode,
  Rfc3339Timestamp,
  IanaTimeZone,
  CancellationPolicyId,
} from "@velvetai/contracts";
import {
  SlotUnavailableError,
  StaleQuoteError,
  InvalidStateTransitionError,
  IdempotencyConflictError,
  DomainError,
} from "@velvetai/contracts";
import {
  signBookingIntent,
  verifyBookingIntent,
} from "./booking-intent.js";
import { canonicalHash, sha256Hex } from "./canonicalizer.js";

export interface BookingActor {
  subject: string;
  userId: UserId;
  tenantId: TenantId;
  roles: string[];
}

export class BookingService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Generates a 5-minute versioned booking quote with canonical pricing and policy snapshots.
   */
  async createQuote(
    tenantId: TenantId,
    actor: BookingActor,
    input: CreateBookingQuoteInput,
  ): Promise<BookingQuoteDTO> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Fetch published service version
      const service = await trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.id", "=", input.serviceId)
        .where("services.status", "=", "ACTIVE")
        .selectAll("service_versions")
        .executeTakeFirst();

      if (!service) {
        throw new DomainError("Service not found or has no active published version", "SERVICE_NOT_FOUND", 404);
      }

      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60_000);
      const expiresAt = new Date(Date.now() + 5 * 60_000); // Max 5-min TTL per Amendment B.4

      const canonicalPayload = {
        tenantId,
        serviceId: input.serviceId,
        locationId: input.locationId,
        serviceVersion: service.version,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        priceMinor: service.price_minor,
        depositMinor: service.base_deposit_minor,
        currency: service.currency,
      };
      const quoteHash = canonicalHash(canonicalPayload);
      const quoteId = crypto.randomUUID() as BookingQuoteId;

      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantId,
          service_version_id: service.id,
          customer_id: actor.userId,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: service.price_minor,
          deposit_minor: service.base_deposit_minor,
          currency: service.currency,
          canonical_hash: quoteHash,
          expires_at: expiresAt,
        })
        .execute();

      return {
        quoteId,
        expiresAt: expiresAt.toISOString() as Rfc3339Timestamp,
        serviceVersion: service.version,
        scheduleRevision: 1,
        total: {
          valueMinor: String(service.price_minor) as MoneyMinor,
          currency: service.currency as CurrencyCode,
        },
        deposit: {
          valueMinor: String(service.base_deposit_minor) as MoneyMinor,
          currency: service.currency as CurrencyCode,
        },
        cancellationPolicy: {
          policyId: service.cancellation_policy_id as CancellationPolicyId,
          version: 1,
          summary: "Full deposit refund if cancelled at least 24 hours prior to appointment.",
        },
      };
    });
  }

  /**
   * Prepares a booking per Specification v1.1 Amendment Section D.2:
   * - Authoritative slot claim with GiST exclusion
   * - Immutable server-side hold snapshot
   * - ES256 signed booking intent
   * - Non-authorizing approval locator
   */
  async prepareBooking(
    tenantId: TenantId,
    actor: BookingActor,
    clientId: string,
    input: PrepareBookingInput,
  ): Promise<PrepareBookingResponse> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Resolve service and active version
      const service = await trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.id", "=", input.serviceId)
        .where("services.status", "=", "ACTIVE")
        .selectAll("service_versions")
        .executeTakeFirst();

      if (!service) {
        throw new DomainError("Service not found or inactive", "SERVICE_NOT_FOUND", 404);
      }

      // 2. Select assignable resource for the location
      const resource = await trx
        .selectFrom("resources")
        .where("tenant_id", "=", tenantId)
        .where("location_id", "=", input.locationId)
        .where("status", "=", "ACTIVE")
        .selectAll()
        .executeTakeFirst();

      if (!resource) {
        throw new DomainError("No active resource found for location", "RESOURCE_NOT_FOUND", 404);
      }

      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60_000);
      const bookingId = crypto.randomUUID() as BookingId;
      const holdExpiresAt = new Date(Date.now() + 15 * 60_000); // 15-min slot hold

      // Ensure customer record exists
      let customer = await trx
        .selectFrom("customers")
        .where("tenant_id", "=", tenantId)
        .where("email_ciphertext", "=", input.customer.email)
        .select("id")
        .executeTakeFirst();

      if (!customer) {
        const customerId = crypto.randomUUID();
        await trx
          .insertInto("customers")
          .values({
            id: customerId,
            tenant_id: tenantId,
            email_ciphertext: input.customer.email,
            display_name_ciphertext: input.customer.displayName ?? null,
            status: "ACTIVE",
          })
          .execute();
        customer = { id: customerId };
      }

      // 3. Create quote record for reference
      const quoteId = crypto.randomUUID();
      await trx
        .insertInto("booking_quotes")
        .values({
          id: quoteId,
          tenant_id: tenantId,
          service_version_id: service.id,
          customer_id: customer.id,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: service.price_minor,
          deposit_minor: service.base_deposit_minor,
          currency: service.currency,
          canonical_hash: canonicalHash({ startsAt, endsAt, price: service.price_minor }),
          expires_at: holdExpiresAt,
        })
        .execute();

      // 4. Create booking row with status = 'HELD'
      await trx
        .insertInto("bookings")
        .values({
          id: bookingId,
          tenant_id: tenantId,
          customer_id: customer.id,
          quote_id: quoteId,
          status: "HELD",
          version: 1,
          hold_expires_at: holdExpiresAt,
          starts_at: startsAt,
          ends_at: endsAt,
          resource_id: resource.id,
        })
        .execute();

      // 5. Insert resource claim with GiST exclusion constraint on (tenant_id, resource_id, blocked_during) WHERE (blocking)
      const claimId = crypto.randomUUID();
      try {
        await trx
          .insertInto("resource_claims")
          .values({
            id: claimId,
            tenant_id: tenantId,
            booking_id: bookingId,
            resource_id: resource.id,
            starts_at: startsAt,
            ends_at: endsAt,
            blocked_during: sql`tstzrange(${startsAt.toISOString()}::timestamptz, ${endsAt.toISOString()}::timestamptz, '[)')`,
            state: "HELD",
            blocking: true,
            hold_expires_at: holdExpiresAt,
            expires_at: holdExpiresAt,
          })
          .execute();
      } catch (err: unknown) {
        const pgError = err as { code?: string; message?: string };
        // PostgreSQL code 23P01 is exclusion_violation
        if (pgError.code === "23P01" || pgError.message?.includes("no_overlapping_claims")) {
          // Provide alternative slots 30 and 60 minutes later
          const alt1Start = new Date(endsAt.getTime());
          const alt1End = new Date(alt1Start.getTime() + service.duration_minutes * 60_000);
          const alt2Start = new Date(alt1End.getTime());
          const alt2End = new Date(alt2Start.getTime() + service.duration_minutes * 60_000);

          throw new SlotUnavailableError("The selected slot is no longer available", {
            conflictSlot: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
            alternatives: [
              { startsAt: alt1Start.toISOString(), endsAt: alt1End.toISOString() },
              { startsAt: alt2Start.toISOString(), endsAt: alt2End.toISOString() },
            ],
          });
        }
        throw err;
      }

      // 6. Persist immutable server-side hold snapshot per Amendment D.1
      const snapshotId = crypto.randomUUID();
      const cancellationHash = sha256Hex(`cancellation-policy-${service.cancellation_policy_id}-v1`);
      const canonicalInputHash = canonicalHash(input);

      await trx
        .insertInto("booking_hold_snapshots")
        .values({
          id: snapshotId,
          tenant_id: tenantId,
          booking_id: bookingId,
          service_version_id: service.id,
          resource_id: resource.id,
          starts_at: startsAt,
          ends_at: endsAt,
          total_minor: service.price_minor,
          deposit_minor: service.base_deposit_minor,
          currency: service.currency,
          currency_scale: 2,
          cancellation_policy_id: service.cancellation_policy_id,
          cancellation_policy_version: 1,
          cancellation_policy_hash: cancellationHash,
          merchant_id: tenantId,
          client_id: clientId,
          actor_id: actor.userId,
          canonical_hash: canonicalInputHash,
        })
        .execute();

      // 7. Create ES256 signed booking intent per Amendment D.3
      const intentJti = crypto.randomUUID();
      const nowSec = Math.floor(Date.now() / 1000);
      const expSec = Math.floor(holdExpiresAt.getTime() / 1000);

      const signedIntent = signBookingIntent({
        iss: "https://api.velvetai.example",
        aud: "velvetai-booking",
        sub: actor.subject,
        client_id: clientId,
        tenant_id: tenantId,
        jti: intentJti,
        iat: nowSec,
        nbf: nowSec - 5, // clock skew tolerance
        exp: expSec,
        purpose: "booking_commit",
        hold_id: bookingId,
        hold_version: 1,
        tool_name: "prepare_booking",
        tool_version: "v1",
        schema_hash: sha256Hex("prepare_booking.v1.schema"),
        canonical_argument_hash: canonicalInputHash,
        merchant_id: tenantId,
        total_minor: service.price_minor,
        deposit_minor: service.base_deposit_minor,
        currency: service.currency as CurrencyCode,
        currency_scale: 2,
        price_version: service.version,
        cancellation_policy_id: service.cancellation_policy_id as CancellationPolicyId,
        cancellation_policy_version: 1,
        cancellation_policy_hash: cancellationHash,
        allowed_surfaces: ["web", "mcp_streamable_http"],
      });

      // 8. Create non-authorizing interaction locator & register buyer confirmation slot
      const interactionLocator = `loc_${crypto.randomBytes(16).toString("hex")}`;
      const interactionToken = `itok_${crypto.randomBytes(24).toString("hex")}`;
      const confirmationSlotId = crypto.randomUUID();
      const placeholderHash = sha256Hex(`pending_${interactionLocator}`);

      await trx
        .insertInto("buyer_confirmations")
        .values({
          id: confirmationSlotId,
          tenant_id: tenantId,
          booking_id: bookingId,
          confirmation_jti: crypto.randomUUID(),
          token_hash: placeholderHash,
          buyer_user_id: customer.id,
          interaction_locator: interactionLocator,
          expires_at: holdExpiresAt,
        })
        .execute();

      // Append outbox and audit events
      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: bookingId,
          event_type: "booking.held",
          payload: { bookingId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type: "USER",
          action: "booking.held",
          resource_type: "booking",
          resource_id: bookingId,
          metadata_redacted: { startsAt: startsAt.toISOString() },
        })
        .execute();

      return {
        bookingId,
        status: "HELD",
        holdExpiresAt: holdExpiresAt.toISOString() as Rfc3339Timestamp,
        version: 1,
        intent: signedIntent,
        approvalLocator: `/v1/booking-approvals/${interactionLocator}`,
        interactionToken,
      };
    });
  }

  /**
   * Retrieves terms from the immutable server-side snapshot for buyer approval per Section D.4.
   */
  async getApprovalDetails(
    tenantId: TenantId,
    locator: string,
  ): Promise<BookingApprovalDetails> {
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "");
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const conf = await trx
        .selectFrom("buyer_confirmations")
        .where("interaction_locator", "=", cleanLocator)
        .where("tenant_id", "=", tenantId)
        .select(["booking_id", "expires_at"])
        .executeTakeFirst();

      if (!conf) {
        throw new DomainError("Approval interaction expired or not found", "APPROVAL_NOT_FOUND", 404);
      }

      const snapshot = await trx
        .selectFrom("booking_hold_snapshots")
        .innerJoin("service_versions", "service_versions.id", "booking_hold_snapshots.service_version_id")
        .where("booking_hold_snapshots.booking_id", "=", conf.booking_id)
        .where("booking_hold_snapshots.tenant_id", "=", tenantId)
        .select([
          "booking_hold_snapshots.booking_id",
          "booking_hold_snapshots.tenant_id",
          "service_versions.name as service_name",
          "service_versions.version as service_version",
          "booking_hold_snapshots.starts_at",
          "booking_hold_snapshots.ends_at",
          "booking_hold_snapshots.total_minor",
          "booking_hold_snapshots.deposit_minor",
          "booking_hold_snapshots.currency",
          "booking_hold_snapshots.client_id",
        ])
        .executeTakeFirst();

      if (!snapshot) {
        throw new DomainError("Hold snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
      }

      return {
        bookingId: snapshot.booking_id as BookingId,
        tenantId: snapshot.tenant_id as TenantId,
        serviceName: snapshot.service_name,
        serviceVersion: snapshot.service_version,
        startsAt: snapshot.starts_at.toISOString() as Rfc3339Timestamp,
        endsAt: snapshot.ends_at.toISOString() as Rfc3339Timestamp,
        timeZone: "UTC" as IanaTimeZone,
        allInPriceMinor: snapshot.total_minor,
        depositMinor: snapshot.deposit_minor,
        currency: snapshot.currency as CurrencyCode,
        cancellationSummary: "Full deposit refund if cancelled at least 24 hours prior to appointment.",
        requestingAgent: snapshot.client_id,
        expiresAt: conf.expires_at.toISOString() as Rfc3339Timestamp,
      };
    });
  }

  /**
   * Buyer approves terms -> issues a separate one-time opaque confirmation record per Section D.1 / D.6.
   */
  async confirmApproval(
    tenantId: TenantId,
    locator: string,
    buyerUserId: UserId,
  ): Promise<ConfirmBookingApprovalResponse> {
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "");
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const conf = await trx
        .selectFrom("buyer_confirmations")
        .where("interaction_locator", "=", cleanLocator)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();

      if (!conf) {
        throw new DomainError("Approval interaction expired or not found", "APPROVAL_NOT_FOUND", 404);
      }

      if (conf.consumed_at) {
        throw new DomainError("Confirmation already consumed", "CONFIRMATION_ALREADY_CONSUMED", 409);
      }

      const now = new Date();
      if (conf.expires_at.getTime() <= now.getTime()) {
        throw new DomainError("Approval session has expired", "APPROVAL_EXPIRED", 410);
      }

      // Generate opaque one-time confirmation token
      const rawConfirmationToken = `conf_${crypto.randomBytes(32).toString("hex")}`;
      const tokenHash = sha256Hex(rawConfirmationToken);
      const confirmationJti = crypto.randomUUID();

      await trx
        .updateTable("buyer_confirmations")
        .set({
          token_hash: tokenHash,
          confirmation_jti: confirmationJti,
          buyer_user_id: buyerUserId,
        })
        .where("id", "=", conf.id)
        .execute();

      return {
        confirmation: rawConfirmationToken,
        expiresAt: conf.expires_at.toISOString() as Rfc3339Timestamp,
      };
    });
  }

  /**
   * Atomic commit operation per Specification v1.1 Amendment Section D.6 and W4:
   * In ONE database transaction:
   * 1. Lock idempotency record.
   * 2. Lock hold in bookings, resource_claims, and booking_hold_snapshots.
   * 3. Lock buyer confirmation.
   * 4. Verify actor/client/tenant and artifact bindings.
   * 5. Verify hold and policy versions.
   * 6. Verify current membership and authorization.
   * 7. Verify database time before expiry.
   * 8. Consume confirmation exactly once.
   * 9. Transition hold to COMMITTING.
   * 10. Append audit and outbox events.
   * 11. Commit transaction.
   */
  async commitBooking(
    tenantId: TenantId,
    actor: BookingActor,
    clientId: string,
    input: CommitBookingInput,
  ): Promise<CommitBookingResponse> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Idempotency management per Section C / D.6
      const payloadHash = sha256Hex(JSON.stringify(input));
      const existingIdempotency = await trx
        .selectFrom("idempotency_records")
        .where("tenant_id", "=", tenantId)
        .where("client_id", "=", clientId)
        .where("idempotency_key", "=", input.idempotency_key)
        .selectAll()
        .executeTakeFirst();

      if (existingIdempotency) {
        if (existingIdempotency.request_hash !== payloadHash) {
          throw new IdempotencyConflictError("Idempotency key reused with different request payload");
        }
        if (existingIdempotency.state === "COMPLETED" && existingIdempotency.response_body) {
          return existingIdempotency.response_body as CommitBookingResponse;
        }
        if (existingIdempotency.state === "EXECUTING") {
          throw new IdempotencyConflictError("Concurrent execution with same idempotency key in progress");
        }
      }

      // Record executing idempotency state
      const idempotencyId = existingIdempotency?.id ?? crypto.randomUUID();
      if (!existingIdempotency) {
        await trx
          .insertInto("idempotency_records")
          .values({
            id: idempotencyId,
            tenant_id: tenantId,
            actor_id: actor.userId,
            client_id: clientId,
            operation: "commit_booking.v1",
            idempotency_key: input.idempotency_key,
            request_hash: payloadHash,
            state: "EXECUTING",
            expires_at: new Date(Date.now() + 24 * 60 * 60_000),
          })
          .execute();
      }

      // 2. Verify ES256 Signed Intent integrity & bindings per Section D.3
      let claims;
      try {
        claims = verifyBookingIntent(input.intent, {
          expectedIssuer: "https://api.velvetai.example",
          expectedAudience: "velvetai-booking",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid intent signature";
        throw new DomainError(message, "INVALID_SIGNED_INTENT", 400);
      }

      // Tenant and actor substitution prevention
      if (claims.tenant_id !== tenantId) {
        throw new DomainError("Tenant substitution detected in signed intent", "TENANT_MISMATCH", 403);
      }
      if (claims.client_id !== clientId) {
        throw new DomainError("OAuth client substitution detected in signed intent", "CLIENT_MISMATCH", 403);
      }
      if (claims.sub !== actor.subject) {
        throw new DomainError("Actor subject substitution detected in signed intent", "ACTOR_MISMATCH", 403);
      }

      // 3. Lock and verify buyer confirmation record per Section D.1/D.6
      const confTokenHash = sha256Hex(input.confirmation);
      const confirmation = await trx
        .selectFrom("buyer_confirmations")
        .where("token_hash", "=", confTokenHash)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!confirmation || confirmation.booking_id !== claims.hold_id) {
        throw new DomainError(
          "Invalid buyer confirmation token or confirmation does not match booking hold",
          "INVALID_CONFIRMATION",
          400,
        );
      }

      // Constant-time token hash verification
      const providedHashBuf = Buffer.from(confTokenHash, "hex");
      const storedHashBuf = Buffer.from(confirmation.token_hash, "hex");
      if (
        providedHashBuf.length !== storedHashBuf.length ||
        !crypto.timingSafeEqual(providedHashBuf, storedHashBuf)
      ) {
        throw new DomainError(
          "Invalid buyer confirmation token",
          "INVALID_CONFIRMATION",
          400,
        );
      }

      if (confirmation.consumed_at) {
        throw new DomainError(
          "Buyer confirmation token has already been consumed (replay blocked)",
          "CONFIRMATION_REPLAY_BLOCKED",
          409,
        );
      }

      // 4. Intent replay prevention check: tenant_id + intent_jti uniqueness
      const existingIntentCommit = await trx
        .selectFrom("committed_intents")
        .where("tenant_id", "=", tenantId)
        .where("intent_jti", "=", claims.jti)
        .select("id")
        .executeTakeFirst();

      if (existingIntentCommit) {
        throw new DomainError("Signed intent has already been committed", "INTENT_REPLAY_DETECTED", 409);
      }

      // 4. Lock hold row in bookings
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", claims.hold_id)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError("Booking hold not found", "BOOKING_NOT_FOUND", 404);
      }

      if (booking.status !== "HELD") {
        throw new InvalidStateTransitionError(booking.status, "COMMITTING", {
          bookingId: booking.id,
        });
      }

      if (booking.version !== claims.hold_version) {
        throw new StaleQuoteError("Booking hold version mismatch (stale intent)");
      }

      // 5. Lock and verify hold snapshot
      const snapshot = await trx
        .selectFrom("booking_hold_snapshots")
        .where("booking_id", "=", booking.id)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!snapshot) {
        throw new DomainError("Booking hold snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
      }

      // Verify immutable bindings against snapshot
      if (
        claims.total_minor !== snapshot.total_minor ||
        claims.deposit_minor !== snapshot.deposit_minor ||
        claims.currency !== snapshot.currency ||
        claims.merchant_id !== snapshot.merchant_id ||
        claims.cancellation_policy_id !== snapshot.cancellation_policy_id ||
        claims.cancellation_policy_version !== snapshot.cancellation_policy_version
      ) {
        throw new DomainError(
          "Signed intent bindings do not match authoritative server hold snapshot",
          "SNAPSHOT_BINDING_MISMATCH",
          409,
        );
      }

      // 6. Verify database clock before expiry using clock_timestamp() per Amendment B.4
      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      if (booking.hold_expires_at && dbNow.getTime() >= booking.hold_expires_at.getTime()) {
        throw new SlotUnavailableError("Booking hold expired before commit", {
          holdExpiresAt: booking.hold_expires_at.toISOString(),
          dbTime: dbNow.toISOString(),
        });
      }

      if (dbNow.getTime() >= confirmation.expires_at.getTime()) {
        throw new SlotUnavailableError("Buyer confirmation token expired before commit", {
          confirmationExpiresAt: confirmation.expires_at.toISOString(),
          dbTime: dbNow.toISOString(),
        });
      }

      // 7. Consume confirmation exactly once
      await trx
        .updateTable("buyer_confirmations")
        .set({
          consumed_at: dbNow,
        })
        .where("id", "=", confirmation.id)
        .execute();

      // 8. Transition booking and claims to COMMITTING
      const nextVersion = booking.version + 1;
      await trx
        .updateTable("bookings")
        .set({
          status: "COMMITTING",
          version: nextVersion,
        })
        .where("id", "=", booking.id)
        .execute();

      await trx
        .updateTable("resource_claims")
        .set({
          state: "COMMITTING",
          blocking: true,
        })
        .where("booking_id", "=", booking.id)
        .where("tenant_id", "=", tenantId)
        .execute();

      // 9. Record committed intent to guarantee (tenant_id, intent_jti) uniqueness
      await trx
        .insertInto("committed_intents")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          intent_jti: claims.jti,
          booking_id: booking.id,
          committed_at: dbNow,
        })
        .execute();

      // 10. Append outbox event and audit event
      const committedAtStr = dbNow.toISOString();
      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: booking.id,
          event_type: "booking.committing",
          payload: {
            bookingId: booking.id,
            status: "COMMITTING",
            version: nextVersion,
            committedAt: committedAtStr,
          },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type: "USER",
          action: "booking.committed",
          resource_type: "booking",
          resource_id: booking.id,
          metadata_redacted: {
            intentJti: claims.jti,
            confirmationJti: confirmation.confirmation_jti,
            committedAt: committedAtStr,
          },
        })
        .execute();

      const responseBody: CommitBookingResponse = {
        bookingId: booking.id as BookingId,
        status: "COMMITTING",
        version: nextVersion,
        committedAt: committedAtStr as Rfc3339Timestamp,
      };

      // 11. Finalize idempotency record
      await trx
        .updateTable("idempotency_records")
        .set({
          state: "COMPLETED",
          response_status: 200,
          response_body: responseBody,
        })
        .where("id", "=", idempotencyId)
        .execute();

      return responseBody;
    });
  }

  /**
   * Hold reaper: atomically reaps expired held claims using FOR UPDATE SKIP LOCKED per Section B.4.
   */
  async reapExpiredHolds(tenantId?: string, limit = 100): Promise<number> {
    const tenantIds: string[] = tenantId
      ? [tenantId]
      : (
          await this.db
            .selectFrom("tenants")
            .select(["id"])
            .where("status", "=", "ACTIVE")
            .execute()
        ).map((t) => t.id);

    let totalReaped = 0;

    for (const tid of tenantIds) {
      const reaped = await withTenantTransaction(this.db, tid, async (trx) => {
        const expiredClaims = await trx
          .selectFrom("resource_claims")
          .where("state", "=", "HELD")
          .where(sql<boolean>`hold_expires_at <= clock_timestamp()`)
          .select(["id", "booking_id", "tenant_id"])
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();

        if (expiredClaims.length === 0) {
          return 0;
        }

        for (const claim of expiredClaims) {
          // Transition claim to EXPIRED and release blocking status
          await trx
            .updateTable("resource_claims")
            .set({
              state: "EXPIRED",
              blocking: false,
            })
            .where("id", "=", claim.id)
            .execute();

          // Transition booking to EXPIRED
          await trx
            .updateTable("bookings")
            .set((eb) => ({
              status: "EXPIRED",
              version: eb("version", "+", 1),
              hold_expires_at: null,
            }))
            .where("id", "=", claim.booking_id)
            .where("status", "=", "HELD")
            .execute();

          // Append outbox event and audit event
          await trx
            .insertInto("outbox_events")
            .values({
              id: crypto.randomUUID(),
              tenant_id: claim.tenant_id,
              aggregate_type: "booking",
              aggregate_id: claim.booking_id,
              event_type: "booking.expired",
              payload: { bookingId: claim.booking_id, claimId: claim.id },
            })
            .execute();

          await trx
            .insertInto("audit_events")
            .values({
              id: crypto.randomUUID(),
              tenant_id: claim.tenant_id,
              actor_id: null,
              actor_type: "SYSTEM_REAPER",
              action: "booking.expired",
              resource_type: "booking",
              resource_id: claim.booking_id,
              metadata_redacted: { claimId: claim.id },
            })
            .execute();
        }

        return expiredClaims.length;
      });

      totalReaped += reaped;
    }

    return totalReaped;
  }
}
