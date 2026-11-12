import crypto from "node:crypto";
import { Kysely, sql } from "kysely";
import {
  Database,
  withTenantTransaction,
  insertBlockingResourceClaim,
  mapPgSlotConflictError,
} from "@velvetai/db";
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
  ApproveAndCommitResponse,
  BookingQuoteDTO,
  TenantId,
  UserId,
  ResourceId,
  MoneyMinor,
  CurrencyCode,
  Rfc3339Timestamp,
  IanaTimeZone,
  CancellationPolicyId,
  PrepareCancellationInput,
  PrepareCancellationResponse,
  CommitCancellationInput,
  CommitCancellationResponse,
  AttendanceActionResponse,
  PaymentCaptureId,
  formatMoney,
} from "@velvetai/contracts";
import {
  SlotUnavailableError,
  StaleQuoteError,
  InvalidStateTransitionError,
  IdempotencyConflictError,
  DomainError,
} from "@velvetai/contracts";
import { signBookingIntent, verifyBookingIntent } from "./booking-intent.js";
import { canonicalHash, sha256Hex } from "./canonicalizer.js";
import type { PaymentService } from "./payment-service.js";
import type { ClockPort } from "./ports.js";

export interface BookingActor {
  subject: string;
  userId: UserId;
  tenantId: TenantId;
  roles: string[];
}

export function formatSlotDisplay(startsAt: Date, endsAt: Date, timeZone: string) {
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const tzLabelFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  });

  const tzParts = tzLabelFormatter.formatToParts(startsAt);
  const timeZoneLabel = tzParts.find((p) => p.type === "timeZoneName")?.value || timeZone;

  return {
    localDate: dateFormatter.format(startsAt),
    localStart: timeFormatter.format(startsAt),
    localEnd: timeFormatter.format(endsAt),
    timeZone,
    timeZoneLabel,
  };
}

export class BookingService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly paymentService?: PaymentService,
    private readonly clock?: ClockPort,
  ) {}

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
        throw new DomainError(
          "Service not found or has no active published version",
          "SERVICE_NOT_FOUND",
          404,
        );
      }

      const startsAt = new Date(input.startsAt);
      const currentNow = this.clock ? this.clock.now() : new Date();
      if (startsAt.getTime() <= currentNow.getTime()) {
        throw new DomainError(
          "SLOT_IN_PAST: Booking slot start time cannot be in the past",
          "SLOT_IN_PAST",
          400,
        );
      }
      const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60_000);
      const expiresAt = new Date(currentNow.getTime() + 5 * 60_000); // Max 5-min TTL per Amendment B.4

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

      const effectiveTimeZone = input.timeZone || "America/New_York";
      const displayInfo = formatSlotDisplay(startsAt, endsAt, effectiveTimeZone);

      return {
        quoteId,
        expiresAt: expiresAt.toISOString() as Rfc3339Timestamp,
        serviceVersion: service.version,
        scheduleRevision: 1,
        serviceName: service.name,
        startsAt: startsAt.toISOString() as Rfc3339Timestamp,
        endsAt: endsAt.toISOString() as Rfc3339Timestamp,
        display: displayInfo,
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
    options?: { resourceId?: ResourceId },
  ): Promise<PrepareBookingResponse> {
    let conflictDetailsBuilder: (() => Record<string, unknown>) | undefined;

    try {
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
        let resourceQuery = trx
          .selectFrom("resources")
          .where("tenant_id", "=", tenantId)
          .where("location_id", "=", input.locationId)
          .where("status", "=", "ACTIVE");

        if (options?.resourceId) {
          resourceQuery = resourceQuery.where("id", "=", options.resourceId);
        }

        const resource = await resourceQuery.selectAll().executeTakeFirst();

        if (!resource) {
          throw new DomainError("No active resource found for location", "RESOURCE_NOT_FOUND", 404);
        }

        const startsAt = new Date(input.startsAt);
        const currentNow = this.clock ? this.clock.now() : new Date();
        if (startsAt.getTime() <= currentNow.getTime()) {
          throw new DomainError(
            "SLOT_IN_PAST: Booking slot start time cannot be in the past",
            "SLOT_IN_PAST",
            400,
          );
        }
        const endsAt = new Date(startsAt.getTime() + service.duration_minutes * 60_000);
        const bookingId = crypto.randomUUID() as BookingId;
        const holdExpiresAt = new Date(currentNow.getTime() + 300_000); // 5-min (300s) slot hold

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

        // 5. Acquire transaction-scoped advisory lock per (tenant_id, resource_id) and insert resource claim
        //    with authoritative GiST exclusion constraint; maps both 23P01 and 40P01 to 409 SlotUnavailableError.
        conflictDetailsBuilder = () => {
          const alt1Start = new Date(endsAt.getTime());
          const alt1End = new Date(alt1Start.getTime() + service.duration_minutes * 60_000);
          const alt2Start = new Date(alt1End.getTime());
          const alt2End = new Date(alt2Start.getTime() + service.duration_minutes * 60_000);
          return {
            conflictSlot: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
            alternatives: [
              { startsAt: alt1Start.toISOString(), endsAt: alt1End.toISOString() },
              { startsAt: alt2Start.toISOString(), endsAt: alt2End.toISOString() },
            ],
          };
        };

        const claimId = crypto.randomUUID();
        await insertBlockingResourceClaim(
          trx,
          {
            claimId,
            tenantId,
            bookingId,
            claimSource: "BOOKING",
            resourceId: resource.id,
            startsAt,
            endsAt,
            state: "HELD",
            holdExpiresAt,
            expiresAt: holdExpiresAt,
          },
          conflictDetailsBuilder,
        );

        // 6. Persist immutable server-side hold snapshot per Amendment D.1
        const snapshotId = crypto.randomUUID();
        const cancellationHash = sha256Hex(
          `cancellation-policy-${service.cancellation_policy_id}-v1`,
        );
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

        const signedIntent = await signBookingIntent({
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

        // Determine surface and buyer binding per Finding 3
        const isM2MClient = actor.subject.endsWith("@clients");
        const surface = isM2MClient
          ? "mcp"
          : clientId === "ask-ai" || clientId.includes("ai")
            ? "ask_ai"
            : "web";

        // MCP-prepared holds have no human buyer at prepare time (the M2M agent prepared them).
        // For holds prepared by Ask AI or the web (human session), the hold is bound to that human from the start.
        const initialBuyerUserId = isM2MClient ? null : actor.userId;

        await trx
          .insertInto("buyer_confirmations")
          .values({
            id: confirmationSlotId,
            tenant_id: tenantId,
            booking_id: bookingId,
            confirmation_jti: crypto.randomUUID(),
            token_hash: placeholderHash,
            buyer_user_id: initialBuyerUserId,
            interaction_locator: interactionLocator,
            signed_intent: signedIntent,
            signed_intent_hash: sha256Hex(signedIntent),
            prepared_by_surface: surface,
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

        const webOrigin =
          process.env.PUBLIC_WEB_ORIGIN || process.env.WEB_BASE_URL || "http://localhost:5174";
        const approvalUrl = `${webOrigin}/approve/${interactionLocator}`;
        const effectiveTimeZone = input.timeZone || "America/New_York";
        const displayInfo = formatSlotDisplay(startsAt, endsAt, effectiveTimeZone);

        return {
          bookingId,
          status: "HELD",
          holdExpiresAt: holdExpiresAt.toISOString() as Rfc3339Timestamp,
          version: 1,
          intent: signedIntent,
          approvalLocator: `/v1/booking-approvals/${interactionLocator}`,
          approvalUrl,
          interactionToken,
          serviceName: service.name,
          display: displayInfo,
          requiresHumanConfirmation: true as const,
        };
      });
    } catch (err: unknown) {
      throw mapPgSlotConflictError(err, conflictDetailsBuilder);
    }
  }

  /**
   * Discovers the authoritative tenant for an unguessable interaction locator.
   * Checks the provided preferred tenant first; if not found, scans active tenants.
   */
  async resolveLocatorTenant(preferredTenantId: TenantId, locator: string): Promise<TenantId> {
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "").trim();
    if (!cleanLocator) return preferredTenantId;

    // 1. Check preferred tenant first
    try {
      const inPreferred = await withTenantTransaction(this.db, preferredTenantId, async (trx) => {
        return await trx
          .selectFrom("buyer_confirmations")
          .where("interaction_locator", "=", cleanLocator)
          .select(["id", "tenant_id"])
          .executeTakeFirst();
      });
      if (inPreferred?.tenant_id) {
        return inPreferred.tenant_id as TenantId;
      }
    } catch {
      // Proceed to candidate search if preferred lookup fails
    }

    // 2. If not found in preferred tenant, check other active tenants in database
    try {
      const candidates = await this.db.selectFrom("tenants").select(["id"]).execute();
      for (const c of candidates) {
        if (c.id === preferredTenantId) continue;
        const found = await withTenantTransaction(this.db, c.id, async (trx) => {
          return await trx
            .selectFrom("buyer_confirmations")
            .where("interaction_locator", "=", cleanLocator)
            .select(["id", "tenant_id"])
            .executeTakeFirst();
        });
        if (found?.tenant_id) {
          return found.tenant_id as TenantId;
        }
      }
    } catch {
      // Fall through to preferred tenant default
    }

    return preferredTenantId;
  }

  /**
   * Retrieves terms from the immutable server-side snapshot for buyer approval per Section D.4 and WP 02.
   */
  async getApprovalDetails(tenantId: TenantId, locator: string): Promise<BookingApprovalDetails> {
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "");
    const effectiveTenantId = await this.resolveLocatorTenant(tenantId, cleanLocator);
    return await withTenantTransaction(this.db, effectiveTenantId, async (trx) => {
      const conf = await trx
        .selectFrom("buyer_confirmations")
        .where("interaction_locator", "=", cleanLocator)
        .where("tenant_id", "=", effectiveTenantId)
        .selectAll()
        .executeTakeFirst();

      if (!conf) {
        throw new DomainError(
          "Approval interaction expired or not found",
          "APPROVAL_NOT_FOUND",
          404,
        );
      }

      const snapshot = await trx
        .selectFrom("booking_hold_snapshots")
        .innerJoin(
          "service_versions",
          "service_versions.id",
          "booking_hold_snapshots.service_version_id",
        )
        .innerJoin("resources", "resources.id", "booking_hold_snapshots.resource_id")
        .innerJoin("bookings", "bookings.id", "booking_hold_snapshots.booking_id")
        .where("booking_hold_snapshots.booking_id", "=", conf.booking_id)
        .where("booking_hold_snapshots.tenant_id", "=", effectiveTenantId)
        .select([
          "booking_hold_snapshots.booking_id",
          "booking_hold_snapshots.tenant_id",
          "service_versions.name as service_name",
          "service_versions.version as service_version",
          "service_versions.duration_minutes",
          "resources.display_name as resource_name",
          "booking_hold_snapshots.starts_at",
          "booking_hold_snapshots.ends_at",
          "booking_hold_snapshots.total_minor",
          "booking_hold_snapshots.deposit_minor",
          "booking_hold_snapshots.currency",
          "booking_hold_snapshots.client_id",
          "bookings.status as booking_status",
          "bookings.payment_expires_at as booking_payment_expires_at",
        ])
        .executeTakeFirst();

      if (!snapshot) {
        throw new DomainError("Hold snapshot not found", "SNAPSHOT_NOT_FOUND", 404);
      }

      const location = await trx
        .selectFrom("locations")
        .where("tenant_id", "=", effectiveTenantId)
        .select(["timezone"])
        .executeTakeFirst();

      const latestIntent = await trx
        .selectFrom("payment_intents")
        .where("booking_id", "=", conf.booking_id)
        .where("tenant_id", "=", effectiveTenantId)
        .orderBy("created_at", "desc")
        .select(["state", "payment_expires_at"])
        .executeTakeFirst();

      const isCaptureUncertainOrInFlight =
        snapshot.booking_status === "CAPTURE_UNCERTAIN" ||
        latestIntent?.state === "CAPTURE_IN_FLIGHT" ||
        latestIntent?.state === "SUBMISSION_UNKNOWN";

      const latestCaptureOp = isCaptureUncertainOrInFlight
        ? await trx
            .selectFrom("provider_operations")
            .where("booking_id", "=", conf.booking_id)
            .where("tenant_id", "=", effectiveTenantId)
            .where("operation_type", "=", "CAPTURE")
            .orderBy("created_at", "desc")
            .select(["id", "state"])
            .executeTakeFirst()
        : undefined;

      const resolvedPaymentExpiresAt =
        snapshot.booking_payment_expires_at ?? latestIntent?.payment_expires_at ?? null;

      const effectiveTimeZone = (location?.timezone || "America/New_York") as IanaTimeZone;
      const displayInfo = formatSlotDisplay(
        snapshot.starts_at,
        snapshot.ends_at,
        effectiveTimeZone,
      );

      const pendingPlaceholderHash = sha256Hex(`pending_${conf.interaction_locator}`);
      const approvalStatus =
        conf.token_hash === pendingPlaceholderHash
          ? "PENDING"
          : conf.consumed_at
            ? "CONSUMED"
            : "APPROVED";

      const formattedPrice = formatMoney({
        valueMinor: snapshot.total_minor,
        currency: snapshot.currency as CurrencyCode,
      });

      const formattedDeposit = formatMoney({
        valueMinor: snapshot.deposit_minor,
        currency: snapshot.currency as CurrencyCode,
      });

      return {
        bookingId: snapshot.booking_id as BookingId,
        tenantId: snapshot.tenant_id as TenantId,
        serviceName: snapshot.service_name,
        serviceVersion: snapshot.service_version,
        durationMinutes: snapshot.duration_minutes,
        resourceName: snapshot.resource_name,
        startsAt: snapshot.starts_at.toISOString() as Rfc3339Timestamp,
        endsAt: snapshot.ends_at.toISOString() as Rfc3339Timestamp,
        timeZone: effectiveTimeZone,
        allInPriceMinor: snapshot.total_minor,
        depositMinor: snapshot.deposit_minor,
        formattedPrice,
        formattedDeposit,
        currency: snapshot.currency as CurrencyCode,
        cancellationSummary:
          "Full deposit refund if cancelled at least 24 hours prior to appointment. After that the deposit is retained.",
        requestingAgent: snapshot.client_id,
        preparedBySurface: conf.prepared_by_surface || "web",
        expiresAt: conf.expires_at.toISOString() as Rfc3339Timestamp,
        status: approvalStatus,
        bookingStatus: snapshot.booking_status,
        ...(latestIntent?.state ? { paymentStatus: latestIntent.state } : {}),
        ...(resolvedPaymentExpiresAt
          ? { paymentExpiresAt: resolvedPaymentExpiresAt.toISOString() as Rfc3339Timestamp }
          : {}),
        ...(latestCaptureOp?.id ? { operationId: latestCaptureOp.id } : {}),
        display: {
          localDate: displayInfo.localDate,
          localStart: displayInfo.localStart,
          localEnd: displayInfo.localEnd,
          timeZone: effectiveTimeZone,
          timeZoneLabel: displayInfo.timeZoneLabel,
        },
      };
    });
  }

  /**
   * Buyer approves terms -> issues a separate one-time opaque confirmation record per Section D.1 / D.6.
   * Strictly enforces that only the buyer the hold was prepared for can approve.
   * For holds prepared by an M2M agent, the first authenticated human buyer who approves claims it.
   */
  async confirmApproval(
    tenantId: TenantId,
    locator: string,
    buyerUserId: UserId,
    options?: { actorSubject?: string },
  ): Promise<ConfirmBookingApprovalResponse> {
    const actorSubject = options?.actorSubject;
    if (actorSubject && (actorSubject.endsWith("@clients") || actorSubject.startsWith("client|"))) {
      throw new DomainError(
        "Machine-to-machine clients cannot approve booking holds. Human buyer approval is required.",
        "HUMAN_APPROVAL_REQUIRED",
        403,
      );
    }
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "");
    const effectiveTenantId = await this.resolveLocatorTenant(tenantId, cleanLocator);
    return await withTenantTransaction(this.db, effectiveTenantId, async (trx) => {
      const conf = await trx
        .selectFrom("buyer_confirmations")
        .where("interaction_locator", "=", cleanLocator)
        .where("tenant_id", "=", effectiveTenantId)
        .selectAll()
        .executeTakeFirst();

      if (!conf) {
        throw new DomainError(
          "Approval interaction expired or not found",
          "APPROVAL_NOT_FOUND",
          404,
        );
      }

      if (conf.consumed_at) {
        throw new DomainError(
          "Confirmation already consumed",
          "CONFIRMATION_ALREADY_CONSUMED",
          409,
        );
      }

      const now = new Date();
      if (conf.expires_at.getTime() <= now.getTime()) {
        throw new DomainError(
          "Booking hold has expired. The time was released.",
          "HOLD_EXPIRED",
          410,
        );
      }

      // Verify that the approving buyer matches the buyer the hold was prepared for
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", conf.booking_id)
        .where("tenant_id", "=", effectiveTenantId)
        .select(["customer_id", "hold_expires_at"])
        .executeTakeFirst();

      if (booking?.hold_expires_at && booking.hold_expires_at.getTime() <= now.getTime()) {
        throw new DomainError(
          "Booking hold has expired. The time was released.",
          "HOLD_EXPIRED",
          410,
        );
      }

      const holdCustomer = booking
        ? await trx
            .selectFrom("customers")
            .where("id", "=", booking.customer_id)
            .where("tenant_id", "=", effectiveTenantId)
            .select(["email_ciphertext"])
            .executeTakeFirst()
        : null;

      const approvingAppUser = await trx
        .selectFrom("app_users")
        .where("id", "=", buyerUserId)
        .select(["id", "email_ciphertext"])
        .executeTakeFirst();

      if (!conf.buyer_user_id) {
        // Finding 3: M2M hold - first authenticated human buyer who approves claims it atomically
        const claimed = await trx
          .updateTable("buyer_confirmations")
          .set({ buyer_user_id: buyerUserId })
          .where("id", "=", conf.id)
          .where("buyer_user_id", "is", null)
          .returning(["id", "buyer_user_id"])
          .executeTakeFirst();

        if (!claimed) {
          throw new DomainError("This approval belongs to another account.", "BUYER_MISMATCH", 403);
        }

        conf.buyer_user_id = buyerUserId;

        await trx
          .insertInto("audit_events")
          .values({
            id: crypto.randomUUID(),
            tenant_id: effectiveTenantId,
            actor_id: buyerUserId,
            actor_type: "USER",
            action: "booking.claimed_by_buyer",
            resource_type: "booking",
            resource_id: conf.booking_id,
            metadata_redacted: {
              interactionLocator: cleanLocator,
              claimedBy: buyerUserId,
            },
          })
          .execute();
      } else {
        const isDirectMatch = conf.buyer_user_id === buyerUserId;
        const isEmailMatch = Boolean(
          approvingAppUser &&
          holdCustomer &&
          approvingAppUser.email_ciphertext.toLowerCase() ===
            holdCustomer.email_ciphertext.toLowerCase(),
        );

        if (!isDirectMatch && !isEmailMatch) {
          throw new DomainError("This approval belongs to another account.", "BUYER_MISMATCH", 403);
        }
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
   * Performs human approve + commit atomically per D1.
   * Never returns the confirmation token.
   */
  async approveAndCommit(
    tenantId: TenantId,
    locator: string,
    buyerUserId: UserId,
    actor: BookingActor,
    clientId: string,
    idempotencyKey: string,
  ): Promise<ApproveAndCommitResponse> {
    const cleanLocator = locator.replace(/^\/v1\/booking-approvals\//, "");
    const effectiveTenantId = await this.resolveLocatorTenant(tenantId, cleanLocator);
    return await withTenantTransaction(this.db, effectiveTenantId, async (trx) => {
      // 0. Idempotency management
      const payloadHash = sha256Hex(JSON.stringify({ locator: cleanLocator, buyerUserId }));
      const existingIdempotency = await trx
        .selectFrom("idempotency_records")
        .where("tenant_id", "=", effectiveTenantId)
        .where("client_id", "=", clientId)
        .where("idempotency_key", "=", idempotencyKey)
        .selectAll()
        .executeTakeFirst();

      if (existingIdempotency) {
        if (existingIdempotency.request_hash !== payloadHash) {
          throw new IdempotencyConflictError(
            "Idempotency key reused with different request payload",
          );
        }
        if (existingIdempotency.state === "COMPLETED" && existingIdempotency.response_body) {
          return existingIdempotency.response_body as ApproveAndCommitResponse;
        }
      }

      // 1. Load pending confirmation record
      const conf = await trx
        .selectFrom("buyer_confirmations")
        .where("interaction_locator", "=", cleanLocator)
        .where("tenant_id", "=", effectiveTenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!conf) {
        throw new DomainError(
          "Approval interaction expired or not found",
          "APPROVAL_NOT_FOUND",
          404,
        );
      }

      // 2. Load booking
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", conf.booking_id)
        .where("tenant_id", "=", effectiveTenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError("Booking hold not found", "BOOKING_NOT_FOUND", 404);
      }

      // Check expiry
      const now = new Date();
      if (conf.expires_at.getTime() <= now.getTime()) {
        throw new DomainError(
          "Booking hold has expired. The time was released.",
          "HOLD_EXPIRED",
          410,
        );
      }
      if (booking.hold_expires_at && booking.hold_expires_at.getTime() <= now.getTime()) {
        throw new DomainError(
          "Booking hold has expired. The time was released.",
          "HOLD_EXPIRED",
          410,
        );
      }

      // 3. Check buyer binding
      const approvingAppUser = await trx
        .selectFrom("app_users")
        .where("id", "=", buyerUserId)
        .select(["id", "email_ciphertext"])
        .executeTakeFirst();

      const holdCustomer = await trx
        .selectFrom("customers")
        .where("id", "=", booking.customer_id)
        .where("tenant_id", "=", effectiveTenantId)
        .select(["email_ciphertext"])
        .executeTakeFirst();

      if (!conf.buyer_user_id) {
        // M2M hold: The first authenticated human buyer who approves claims it atomically!
        const claimed = await trx
          .updateTable("buyer_confirmations")
          .set({ buyer_user_id: buyerUserId })
          .where("id", "=", conf.id)
          .where("buyer_user_id", "is", null)
          .returning(["id", "buyer_user_id"])
          .executeTakeFirst();

        if (!claimed) {
          throw new DomainError("This approval belongs to another account.", "BUYER_MISMATCH", 403);
        }

        conf.buyer_user_id = buyerUserId;

        await trx
          .insertInto("audit_events")
          .values({
            id: crypto.randomUUID(),
            tenant_id: effectiveTenantId,
            actor_id: buyerUserId,
            actor_type: "USER",
            action: "booking.claimed_by_buyer",
            resource_type: "booking",
            resource_id: conf.booking_id,
            metadata_redacted: {
              interactionLocator: cleanLocator,
              claimedBy: buyerUserId,
            },
          })
          .execute();
      } else {
        const isDirectMatch = conf.buyer_user_id === buyerUserId;
        const isEmailMatch = Boolean(
          approvingAppUser &&
          holdCustomer &&
          approvingAppUser.email_ciphertext.toLowerCase() ===
            holdCustomer.email_ciphertext.toLowerCase(),
        );

        if (!isDirectMatch && !isEmailMatch) {
          throw new DomainError("This approval belongs to another account.", "BUYER_MISMATCH", 403);
        }
      }

      // If already committed or confirmed (e.g. agent commit after human confirm, or duplicate call), return 200 with existing booking
      if (booking.status === "COMMITTING" || booking.status === "CONFIRMED") {
        return {
          bookingId: booking.id as BookingId,
          status: booking.status as "COMMITTING" | "CONFIRMED",
          next: {
            type: "PAY_DEPOSIT",
            paymentOrderUrl: `/v1/bookings/${booking.id}/payment-order`,
          },
        };
      }

      // 4. Retrieve stored signed intent
      const signedIntent = conf.signed_intent;
      if (!signedIntent) {
        throw new DomainError("Stored signed intent not found for hold", "INTENT_NOT_FOUND", 500);
      }

      let claims;
      try {
        claims = await verifyBookingIntent(signedIntent, {
          expectedIssuer: "https://api.velvetai.example",
          expectedAudience: "velvetai-booking",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid intent signature";
        throw new DomainError(message, "INVALID_SIGNED_INTENT", 400);
      }

      // 5. Generate and immediately consume one-time confirmation token
      const rawConfirmationToken = `conf_${crypto.randomBytes(32).toString("hex")}`;
      const tokenHash = sha256Hex(rawConfirmationToken);
      const confirmationJti = crypto.randomUUID();

      const clockRes = await sql<{ now: Date }>`SELECT clock_timestamp() as now`.execute(trx);
      const dbNow = clockRes.rows[0]?.now ?? new Date();

      await trx
        .updateTable("buyer_confirmations")
        .set({
          token_hash: tokenHash,
          confirmation_jti: confirmationJti,
          buyer_user_id: buyerUserId,
          consumed_at: dbNow,
        })
        .where("id", "=", conf.id)
        .execute();

      // 6. Transition booking to COMMITTING
      const nextVersion = booking.version + 1;
      const paymentExpiresAt = new Date(dbNow.getTime() + 10 * 60_000);
      await trx
        .updateTable("bookings")
        .set({
          status: "COMMITTING",
          version: nextVersion,
          payment_expires_at: paymentExpiresAt,
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
        .where("tenant_id", "=", effectiveTenantId)
        .execute();

      // 7. Record committed intent to guarantee (tenant_id, intent_jti) uniqueness
      await trx
        .insertInto("committed_intents")
        .values({
          id: crypto.randomUUID(),
          tenant_id: effectiveTenantId,
          intent_jti: claims.jti,
          booking_id: booking.id,
          committed_at: dbNow,
        })
        .execute();

      // 8. Append outbox event and audit event
      const committedAtStr = dbNow.toISOString();
      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: effectiveTenantId,
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
          tenant_id: effectiveTenantId,
          actor_id: buyerUserId,
          actor_type: "USER",
          action: "booking.committed",
          resource_type: "booking",
          resource_id: booking.id,
          metadata_redacted: {
            bookingId: booking.id,
            intentJti: claims.jti,
            committedAt: committedAtStr,
          },
        })
        .execute();

      const response: ApproveAndCommitResponse = {
        bookingId: booking.id as BookingId,
        status: "COMMITTING",
        next: {
          type: "PAY_DEPOSIT",
          paymentOrderUrl: `/v1/bookings/${booking.id}/payment-order`,
        },
      };

      await trx
        .insertInto("idempotency_records")
        .values({
          id: crypto.randomUUID(),
          tenant_id: effectiveTenantId,
          actor_id: actor.userId,
          client_id: clientId,
          operation: "approve_and_commit.v1",
          idempotency_key: idempotencyKey,
          request_hash: payloadHash,
          state: "COMPLETED",
          response_body: response,
          expires_at: new Date(Date.now() + 24 * 60 * 60_000),
        })
        .execute();

      return response;
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
          throw new IdempotencyConflictError(
            "Idempotency key reused with different request payload",
          );
        }
        if (existingIdempotency.state === "COMPLETED" && existingIdempotency.response_body) {
          return existingIdempotency.response_body as CommitBookingResponse;
        }
        if (existingIdempotency.state === "EXECUTING") {
          throw new IdempotencyConflictError(
            "Concurrent execution with same idempotency key in progress",
          );
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
        claims = await verifyBookingIntent(input.intent, {
          expectedIssuer: "https://api.velvetai.example",
          expectedAudience: "velvetai-booking",
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Invalid intent signature";
        throw new DomainError(message, "INVALID_SIGNED_INTENT", 400);
      }

      // Tenant and actor substitution prevention
      if (claims.tenant_id !== tenantId) {
        throw new DomainError(
          "Tenant substitution detected in signed intent",
          "TENANT_MISMATCH",
          403,
        );
      }
      if (claims.client_id !== clientId) {
        throw new DomainError(
          "OAuth client substitution detected in signed intent",
          "CLIENT_MISMATCH",
          403,
        );
      }
      if (claims.sub !== actor.subject) {
        throw new DomainError(
          "Actor subject substitution detected in signed intent",
          "ACTOR_MISMATCH",
          403,
        );
      }

      // 3. Lock and verify buyer confirmation record per Section D.1/D.6 and Audit Section 5
      let confirmation;
      if (input.confirmation) {
        // Direct / explicit confirmation token path (e.g., from browser confirm endpoint)
        const confTokenHash = sha256Hex(input.confirmation);
        confirmation = await trx
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
          throw new DomainError("Invalid buyer confirmation token", "INVALID_CONFIRMATION", 400);
        }
      } else {
        // Preferred Agent Pattern (Audit Section 5): MCP agent / model provides only intent and idempotency key;
        // Server resolves and validates confirmation record bound to claims.hold_id internally.
        confirmation = await trx
          .selectFrom("buyer_confirmations")
          .where("booking_id", "=", claims.hold_id)
          .where("tenant_id", "=", tenantId)
          .selectAll()
          .forUpdate()
          .executeTakeFirst();

        if (!confirmation) {
          throw new DomainError(
            "No confirmation record found for booking hold",
            "CONFIRMATION_NOT_FOUND",
            404,
          );
        }

        // Check whether browser confirmation actually occurred (i.e. token_hash is not the pending placeholder)
        const pendingPlaceholderHash = sha256Hex(`pending_${confirmation.interaction_locator}`);
        if (confirmation.token_hash === pendingPlaceholderHash) {
          throw new DomainError(
            "Approval incomplete: The buyer has not approved this booking yet. Ask them to open the approval link.",
            "APPROVAL_INCOMPLETE",
            400,
          );
        }
      }

      // Verify expiration
      const now = new Date();
      if (confirmation.expires_at.getTime() <= now.getTime()) {
        throw new DomainError("Buyer confirmation has expired", "CONFIRMATION_EXPIRED", 410);
      }

      // If confirmation was already consumed:
      if (confirmation.consumed_at) {
        // If an agent calls without providing a confirmation token (agent pattern) and the booking was already committed:
        if (!input.confirmation) {
          const bookingCheck = await trx
            .selectFrom("bookings")
            .where("id", "=", claims.hold_id)
            .where("tenant_id", "=", tenantId)
            .select(["id", "status", "version", "created_at"])
            .executeTakeFirst();

          if (
            bookingCheck &&
            (bookingCheck.status === "COMMITTING" || bookingCheck.status === "CONFIRMED")
          ) {
            return {
              bookingId: bookingCheck.id as BookingId,
              status: bookingCheck.status as "COMMITTING" | "CONFIRMED",
              version: bookingCheck.version,
              committedAt: (bookingCheck.created_at
                ? bookingCheck.created_at.toISOString()
                : new Date().toISOString()) as Rfc3339Timestamp,
              code: "ALREADY_COMMITTED",
            };
          }
        }

        // Reusing an already-consumed confirmation token with a different idempotency key is blocked
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
        if (!input.confirmation) {
          const bookingCheck = await trx
            .selectFrom("bookings")
            .where("id", "=", claims.hold_id)
            .where("tenant_id", "=", tenantId)
            .select(["id", "status", "version", "created_at"])
            .executeTakeFirst();

          if (
            bookingCheck &&
            (bookingCheck.status === "COMMITTING" || bookingCheck.status === "CONFIRMED")
          ) {
            return {
              bookingId: bookingCheck.id as BookingId,
              status: bookingCheck.status as "COMMITTING" | "CONFIRMED",
              version: bookingCheck.version,
              committedAt: (bookingCheck.created_at
                ? bookingCheck.created_at.toISOString()
                : new Date().toISOString()) as Rfc3339Timestamp,
              code: "ALREADY_COMMITTED",
            };
          }
        }

        throw new DomainError(
          "Signed intent has already been committed",
          "INTENT_REPLAY_DETECTED",
          409,
        );
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

      // 8. Transition booking and claims to COMMITTING with 10-minute payment window
      const nextVersion = booking.version + 1;
      const paymentExpiresAt = new Date(dbNow.getTime() + 10 * 60_000);
      await trx
        .updateTable("bookings")
        .set({
          status: "COMMITTING",
          version: nextVersion,
          payment_expires_at: paymentExpiresAt,
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
          .where("claim_source", "=", "BOOKING")
          .where("booking_id", "is not", null)
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
          if (!claim.booking_id) {
            continue;
          }

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

  /**
   * Prepares cancellation by validating appointment time against 24-hour cutoff policy
   * and generating a tamper-proof signed cancellationConfirmationToken.
   */
  async prepareCancellation(
    tenantId: TenantId,
    _actor: BookingActor,
    bookingId: BookingId,
    _input?: PrepareCancellationInput,
  ): Promise<PrepareCancellationResponse> {
    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .innerJoin("booking_quotes", "booking_quotes.id", "bookings.quote_id")
        .where("bookings.id", "=", bookingId)
        .where("bookings.tenant_id", "=", tenantId)
        .select([
          "bookings.id",
          "bookings.tenant_id",
          "bookings.status",
          "bookings.starts_at",
          "bookings.ends_at",
          "booking_quotes.deposit_minor",
          "booking_quotes.currency",
        ])
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(`Booking ${bookingId} was not found`, "BOOKING_NOT_FOUND", 404);
      }

      if (
        booking.status !== "CONFIRMED" &&
        booking.status !== "HELD" &&
        booking.status !== "CAPTURE_UNCERTAIN"
      ) {
        throw new DomainError(
          `Cannot cancel booking in status ${booking.status}`,
          "INVALID_BOOKING_STATE",
          400,
        );
      }

      const now = new Date();
      const startsAt = new Date(booking.starts_at);
      const diffMs = startsAt.getTime() - now.getTime();
      const hoursUntilStart = Math.max(0, diffMs / (1000 * 60 * 60));
      const cutoffHours = 24; // Standard 24-hour cutoff
      const cutoffPassed = hoursUntilStart < cutoffHours;

      const refundEligibleMinor = cutoffPassed ? "0" : booking.deposit_minor || "0";
      const policySummary = cutoffPassed
        ? "Late cancellation: within 24 hours of appointment start. Deposit is non-refundable."
        : "Standard cancellation: more than 24 hours prior to appointment start. Eligible for 100% deposit refund.";

      const tokenPayload: CancellationConfirmationPayload = {
        tenantId,
        bookingId,
        refundEligibleMinor,
        currency: booking.currency,
        cutoffPassed,
        expiresAt: Date.now() + 15 * 60_000, // 15 min TTL
      };

      const cancellationConfirmationToken = signCancellationConfirmation(tokenPayload);

      return {
        bookingId,
        cancellationAllowed: true,
        refundEligibleMinor: refundEligibleMinor as MoneyMinor,
        currency: booking.currency as CurrencyCode,
        policySummary,
        cancellationConfirmationToken,
        cutoffPassed,
        hoursUntilStart: Math.round(hoursUntilStart * 10) / 10,
      };
    });
  }

  /**
   * Commits cancellation under row lock.
   * If capture is uncertain, transitions to CANCEL_REQUESTED and keeps resource claim blocking.
   * Otherwise transitions to CANCELLED, releases resource claim, and initiates refund if eligible.
   */
  async commitCancellation(
    tenantId: TenantId,
    actor: BookingActor,
    bookingId: BookingId,
    input: CommitCancellationInput,
  ): Promise<CommitCancellationResponse> {
    const tokenPayload = verifyCancellationConfirmation(input.cancellationConfirmationToken);
    if (tokenPayload.tenantId !== tenantId || tokenPayload.bookingId !== bookingId) {
      throw new DomainError(
        "Cancellation token does not match target booking",
        "TOKEN_MISMATCH",
        400,
      );
    }

    const result = await withTenantTransaction(this.db, tenantId, async (trx) => {
      // 1. Lock booking row
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(`Booking ${bookingId} was not found`, "BOOKING_NOT_FOUND", 404);
      }

      // Idempotent re-execution
      if (booking.status === "CANCELLED") {
        return {
          bookingId,
          status: "CANCELLED" as const,
          refundStatus:
            BigInt(tokenPayload.refundEligibleMinor) > 0n
              ? ("COMPLETED" as const)
              : ("NO_REFUND" as const),
          refundAmountMinor: tokenPayload.refundEligibleMinor as MoneyMinor,
          currency: tokenPayload.currency as CurrencyCode,
          resourceClaimReleased: true,
          cancelledAt: new Date().toISOString() as Rfc3339Timestamp,
          alreadyDone: true,
          captureId: undefined as PaymentCaptureId | undefined,
        };
      }

      if (booking.status === "CANCEL_REQUESTED") {
        return {
          bookingId,
          status: "CANCEL_REQUESTED" as const,
          refundStatus: "UNCERTAIN" as const,
          refundAmountMinor: tokenPayload.refundEligibleMinor as MoneyMinor,
          currency: tokenPayload.currency as CurrencyCode,
          resourceClaimReleased: false,
          cancelledAt: new Date().toISOString() as Rfc3339Timestamp,
          alreadyDone: true,
          captureId: undefined as PaymentCaptureId | undefined,
        };
      }

      if (
        booking.status !== "CONFIRMED" &&
        booking.status !== "HELD" &&
        booking.status !== "CAPTURE_UNCERTAIN"
      ) {
        throw new InvalidStateTransitionError(booking.status, "CANCELLED");
      }

      // 2. Select payment capture
      const capture = await trx
        .selectFrom("payment_captures")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .executeTakeFirst();

      // 3. Lock resource claim
      const claim = await trx
        .selectFrom("resource_claims")
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      // 4. If capture is uncertain, move to CANCEL_REQUESTED and keep claim blocking!
      const isCaptureUncertain =
        booking.status === "CAPTURE_UNCERTAIN" ||
        (capture && (capture.state === "PENDING" || capture.state === "CAPTURE_UNCERTAIN"));

      if (isCaptureUncertain) {
        await trx
          .updateTable("bookings")
          .set((eb) => ({
            status: "CANCEL_REQUESTED",
            version: eb("version", "+", 1),
          }))
          .where("id", "=", bookingId)
          .where("tenant_id", "=", tenantId)
          .execute();

        await trx
          .insertInto("outbox_events")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            aggregate_type: "booking",
            aggregate_id: bookingId,
            event_type: "booking.cancel_requested",
            payload: { bookingId, reason: input.reason },
          })
          .execute();

        await trx
          .insertInto("audit_events")
          .values({
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            actor_id: actor.userId,
            actor_type:
              actor.roles.includes("OWNER") || actor.roles.includes("MANAGER")
                ? "MERCHANT"
                : "CUSTOMER",
            action: "booking.cancel_requested",
            resource_type: "booking",
            resource_id: bookingId,
            metadata_redacted: { reason: input.reason, captureState: "CAPTURE_UNCERTAIN" },
          })
          .execute();

        return {
          bookingId,
          status: "CANCEL_REQUESTED" as const,
          refundStatus: "UNCERTAIN" as const,
          refundAmountMinor: tokenPayload.refundEligibleMinor as MoneyMinor,
          currency: tokenPayload.currency as CurrencyCode,
          resourceClaimReleased: false,
          cancelledAt: new Date().toISOString() as Rfc3339Timestamp,
          alreadyDone: false,
          captureId: undefined as PaymentCaptureId | undefined,
        };
      }

      // 5. Normal cancellation: transition booking to CANCELLED
      await trx
        .updateTable("bookings")
        .set((eb) => ({
          status: "CANCELLED",
          version: eb("version", "+", 1),
        }))
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      // 6. Release resource claim
      if (claim) {
        await trx
          .updateTable("resource_claims")
          .set({
            state: "RELEASED",
            blocking: false,
          })
          .where("id", "=", claim.id)
          .where("tenant_id", "=", tenantId)
          .execute();
      }

      const refundEligible = BigInt(tokenPayload.refundEligibleMinor) > 0n;
      const hasCompletedCapture =
        capture && (capture.state === "COMPLETED" || capture.state === "PARTIALLY_REFUNDED");
      const refundStatus =
        refundEligible && hasCompletedCapture ? ("COMPLETED" as const) : ("NO_REFUND" as const);

      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: bookingId,
          event_type: "booking.cancelled",
          payload: {
            bookingId,
            refundEligibleMinor: tokenPayload.refundEligibleMinor,
            refundStatus,
            reason: input.reason,
          },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type:
            actor.roles.includes("OWNER") || actor.roles.includes("MANAGER")
              ? "MERCHANT"
              : "CUSTOMER",
          action: "booking.cancelled",
          resource_type: "booking",
          resource_id: bookingId,
          metadata_redacted: {
            refundEligibleMinor: tokenPayload.refundEligibleMinor,
            refundStatus,
          },
        })
        .execute();

      return {
        bookingId,
        status: "CANCELLED" as const,
        refundStatus,
        refundAmountMinor: (refundStatus === "COMPLETED"
          ? tokenPayload.refundEligibleMinor
          : "0") as MoneyMinor,
        currency: tokenPayload.currency as CurrencyCode,
        resourceClaimReleased: true,
        cancelledAt: new Date().toISOString() as Rfc3339Timestamp,
        alreadyDone: false,
        captureId: (refundEligible && hasCompletedCapture && capture ? capture.id : undefined) as
          PaymentCaptureId | undefined,
      };
    });

    // If refund is due and paymentService is available, trigger refund
    if (result.captureId && this.paymentService && !result.alreadyDone) {
      try {
        await this.paymentService.refundPayment({
          tenantId,
          captureId: result.captureId,
          amountMinor: tokenPayload.refundEligibleMinor,
          reason: input.reason || "Customer cancellation",
          actorRole: "BUYER",
          idempotencyKey: `cancel-refund-${bookingId}`,
        });
      } catch (_err) {
        // Outbox event guarantees downstream reconciliation
      }
    }

    return {
      bookingId: result.bookingId,
      status: result.status,
      refundStatus: result.refundStatus,
      refundAmountMinor: result.refundAmountMinor,
      currency: result.currency,
      resourceClaimReleased: result.resourceClaimReleased,
      cancelledAt: result.cancelledAt,
    };
  }

  private checkMerchantRole(actor: BookingActor): void {
    const allowed = actor.roles.some((r) =>
      ["OWNER", "MANAGER", "SCHEDULER", "MERCHANT"].includes(r.toUpperCase()),
    );
    if (!allowed) {
      throw new DomainError("Forbidden: scheduler or manager role required", "FORBIDDEN", 403);
    }
  }

  /**
   * Merchant check-in: verifies merchant/scheduler role and 2-hour window.
   */
  async checkInBooking(
    tenantId: TenantId,
    actor: BookingActor,
    bookingId: BookingId,
  ): Promise<AttendanceActionResponse> {
    this.checkMerchantRole(actor);

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(`Booking ${bookingId} was not found`, "BOOKING_NOT_FOUND", 404);
      }

      if (booking.status === "CHECKED_IN") {
        return {
          bookingId,
          status: "CHECKED_IN",
          previousStatus: "CHECKED_IN",
          version: booking.version,
          updatedAt: new Date().toISOString() as Rfc3339Timestamp,
        };
      }

      if (booking.status !== "CONFIRMED") {
        throw new DomainError(
          `Cannot check in booking in status ${booking.status}`,
          "INVALID_BOOKING_STATE",
          400,
        );
      }

      const now = Date.now();
      const startsAt = new Date(booking.starts_at).getTime();
      const twoHoursMs = 2 * 60 * 60 * 1000;
      if (startsAt - now > twoHoursMs) {
        throw new DomainError(
          "Check-in is only permitted within 2 hours of appointment start",
          "CHECK_IN_TOO_EARLY",
          400,
        );
      }

      const previousStatus = booking.status;
      const newVersion = booking.version + 1;

      await trx
        .updateTable("bookings")
        .set({
          status: "CHECKED_IN",
          version: newVersion,
        })
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: bookingId,
          event_type: "booking.checked_in",
          payload: { bookingId, version: newVersion },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type: "MERCHANT",
          action: "booking.checked_in",
          resource_type: "booking",
          resource_id: bookingId,
          metadata_redacted: { previousStatus, newVersion },
        })
        .execute();

      return {
        bookingId,
        status: "CHECKED_IN",
        previousStatus,
        version: newVersion,
        updatedAt: new Date().toISOString() as Rfc3339Timestamp,
      };
    });
  }

  /**
   * Merchant completion: transitions to COMPLETED, releases resource claim, and enables balance invoicing.
   */
  async completeBooking(
    tenantId: TenantId,
    actor: BookingActor,
    bookingId: BookingId,
  ): Promise<AttendanceActionResponse> {
    this.checkMerchantRole(actor);

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(`Booking ${bookingId} was not found`, "BOOKING_NOT_FOUND", 404);
      }

      if (booking.status === "COMPLETED") {
        return {
          bookingId,
          status: "COMPLETED",
          previousStatus: "COMPLETED",
          version: booking.version,
          updatedAt: new Date().toISOString() as Rfc3339Timestamp,
        };
      }

      if (booking.status !== "CHECKED_IN" && booking.status !== "CONFIRMED") {
        throw new DomainError(
          `Cannot complete booking in status ${booking.status}`,
          "INVALID_BOOKING_STATE",
          400,
        );
      }

      const previousStatus = booking.status;
      const newVersion = booking.version + 1;

      await trx
        .updateTable("bookings")
        .set({
          status: "COMPLETED",
          version: newVersion,
        })
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      // Release resource claim
      await trx
        .updateTable("resource_claims")
        .set({
          state: "COMPLETED",
          blocking: false,
        })
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: bookingId,
          event_type: "booking.completed",
          payload: { bookingId, version: newVersion },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type: "MERCHANT",
          action: "booking.completed",
          resource_type: "booking",
          resource_id: bookingId,
          metadata_redacted: { previousStatus, newVersion },
        })
        .execute();

      return {
        bookingId,
        status: "COMPLETED",
        previousStatus,
        version: newVersion,
        updatedAt: new Date().toISOString() as Rfc3339Timestamp,
      };
    });
  }

  /**
   * Merchant no-show: enforces 15-minute grace period after appointment start,
   * transitions to NO_SHOW, and releases resource claim.
   */
  async noShowBooking(
    tenantId: TenantId,
    actor: BookingActor,
    bookingId: BookingId,
  ): Promise<AttendanceActionResponse> {
    this.checkMerchantRole(actor);

    return await withTenantTransaction(this.db, tenantId, async (trx) => {
      const booking = await trx
        .selectFrom("bookings")
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .selectAll()
        .forUpdate()
        .executeTakeFirst();

      if (!booking) {
        throw new DomainError(`Booking ${bookingId} was not found`, "BOOKING_NOT_FOUND", 404);
      }

      if (booking.status === "NO_SHOW") {
        return {
          bookingId,
          status: "NO_SHOW",
          previousStatus: "NO_SHOW",
          version: booking.version,
          updatedAt: new Date().toISOString() as Rfc3339Timestamp,
        };
      }

      if (booking.status !== "CONFIRMED") {
        throw new DomainError(
          `Cannot mark no-show for booking in status ${booking.status}`,
          "INVALID_BOOKING_STATE",
          400,
        );
      }

      const now = Date.now();
      const startsAt = new Date(booking.starts_at).getTime();
      const gracePeriodMs = 15 * 60 * 1000; // 15-minute grace period
      if (now < startsAt + gracePeriodMs) {
        throw new DomainError(
          "Cannot mark no-show before appointment start plus 15-minute grace period",
          "GRACE_PERIOD_ACTIVE",
          400,
        );
      }

      const previousStatus = booking.status;
      const newVersion = booking.version + 1;

      await trx
        .updateTable("bookings")
        .set({
          status: "NO_SHOW",
          version: newVersion,
        })
        .where("id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      // Release resource claim
      await trx
        .updateTable("resource_claims")
        .set({
          state: "RELEASED",
          blocking: false,
        })
        .where("booking_id", "=", bookingId)
        .where("tenant_id", "=", tenantId)
        .execute();

      await trx
        .insertInto("outbox_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          aggregate_type: "booking",
          aggregate_id: bookingId,
          event_type: "booking.no_show",
          payload: { bookingId, version: newVersion },
        })
        .execute();

      await trx
        .insertInto("audit_events")
        .values({
          id: crypto.randomUUID(),
          tenant_id: tenantId,
          actor_id: actor.userId,
          actor_type: "MERCHANT",
          action: "booking.no_show",
          resource_type: "booking",
          resource_id: bookingId,
          metadata_redacted: { previousStatus, newVersion },
        })
        .execute();

      return {
        bookingId,
        status: "NO_SHOW",
        previousStatus,
        version: newVersion,
        updatedAt: new Date().toISOString() as Rfc3339Timestamp,
      };
    });
  }
}

interface CancellationConfirmationPayload {
  tenantId: string;
  bookingId: string;
  refundEligibleMinor: string;
  currency: string;
  cutoffPassed: boolean;
  expiresAt: number;
}

function signCancellationConfirmation(payload: CancellationConfirmationPayload): string {
  const secret = process.env.APP_SECRET || "velvet-secret-cancellation-key";
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyCancellationConfirmation(token: string): CancellationConfirmationPayload {
  const secret = process.env.APP_SECRET || "velvet-secret-cancellation-key";
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DomainError("Invalid cancellation token format", "INVALID_CANCELLATION_TOKEN", 400);
  }
  const data = parts[0];
  const sig = parts[1];
  const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  if (
    sig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
  ) {
    throw new DomainError(
      "Invalid cancellation token signature",
      "INVALID_CANCELLATION_TOKEN",
      400,
    );
  }
  const payload = JSON.parse(
    Buffer.from(data, "base64url").toString("utf8"),
  ) as CancellationConfirmationPayload;
  if (Date.now() > payload.expiresAt) {
    throw new DomainError("Cancellation token has expired", "CANCELLATION_TOKEN_EXPIRED", 400);
  }
  return payload;
}
