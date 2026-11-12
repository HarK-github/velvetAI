import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import {
  DomainError,
  IanaTimeZone,
  Rfc3339Timestamp,
  ScheduleEvent,
  SchedulePaymentState,
  SchedulePreparedBy,
  ScheduleResource,
  ScheduleResourceKind,
  ScheduleResponse,
  TenantId,
} from "@velvetai/contracts";
import { formatSlotDisplay } from "./booking-service.js";
import { canonicalHash } from "./canonicalizer.js";
import type { ClockPort } from "./ports.js";

const MAX_SCHEDULE_RANGE_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_VISIBLE_BOOKING_STATUSES = new Set(["COMPLETED", "NO_SHOW", "CANCELLED"]);

export interface SchedulePaymentStateInput {
  bookingStatus: string;
  paymentIntentState?: string | null;
  captureState?: string | null;
  capturedMinor?: string | number | bigint | null;
  refundedMinor?: string | number | bigint | null;
  refundStates?: readonly string[];
  depositPaidFlag?: boolean;
}

/**
 * Pure mapper converting persisted booking/payment/capture/refund states into
 * the canonical scheduler UI paymentState enum.
 */
export function toSchedulePaymentState(input: SchedulePaymentStateInput): SchedulePaymentState {
  const captureState = input.captureState?.toUpperCase() ?? null;
  const intentState = input.paymentIntentState?.toUpperCase() ?? null;
  const bookingStatus = input.bookingStatus.toUpperCase();
  const refundStates = (input.refundStates ?? []).map((s) => s.toUpperCase());

  // 1. Explicitly refunded captures or completed refunds take precedence
  if (captureState === "REFUNDED") {
    return "REFUNDED";
  }
  if (captureState === "PARTIALLY_REFUNDED") {
    return "PARTIALLY_REFUNDED";
  }

  const capturedMinor =
    input.capturedMinor !== undefined && input.capturedMinor !== null
      ? BigInt(input.capturedMinor)
      : 0n;
  const refundedMinor =
    input.refundedMinor !== undefined && input.refundedMinor !== null
      ? BigInt(input.refundedMinor)
      : 0n;

  if (refundedMinor > 0n && capturedMinor > 0n) {
    return refundedMinor >= capturedMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
  }
  if (refundStates.includes("COMPLETED")) {
    return "REFUNDED";
  }

  // 2. Capture state
  if (captureState === "COMPLETED") {
    return "PAID";
  }
  if (captureState === "PENDING") {
    return "VERIFYING";
  }
  if (captureState === "DECLINED" || captureState === "FAILED") {
    return "FAILED";
  }

  // 3. Payment intent state
  if (intentState === "CAPTURED") {
    return "PAID";
  }
  if (
    intentState === "CAPTURE_IN_FLIGHT" ||
    intentState === "CAPTURE_UNCERTAIN" ||
    intentState === "MANUAL_REVIEW" ||
    intentState === "ORDER_CREATE_UNKNOWN"
  ) {
    return "VERIFYING";
  }
  if (intentState === "ORDER_CREATE_PENDING" || intentState === "REQUIRES_PAYER_ACTION") {
    return "AWAITING_PAYER";
  }
  if (intentState === "PAYMENT_FAILED" || intentState === "PAYMENT_WINDOW_EXPIRED") {
    return "FAILED";
  }

  // 4. Demo fixture explicit flag
  if (input.depositPaidFlag !== undefined) {
    return input.depositPaidFlag ? "PAID" : "NONE";
  }

  // 5. Fallback from booking status
  if (
    bookingStatus === "CONFIRMED" ||
    bookingStatus === "CHECKED_IN" ||
    bookingStatus === "COMPLETED" ||
    bookingStatus === "NO_SHOW"
  ) {
    return "PAID";
  }
  if (
    bookingStatus === "COMMITTING" ||
    bookingStatus === "REQUIRES_PAYER_ACTION" ||
    bookingStatus === "PAYMENT_PENDING"
  ) {
    return "AWAITING_PAYER";
  }
  if (bookingStatus === "CAPTURE_UNCERTAIN") {
    return "VERIFYING";
  }
  if (bookingStatus === "PAYMENT_FAILED" || bookingStatus === "PAYMENT_WINDOW_EXPIRED") {
    return "FAILED";
  }

  return "NONE";
}

/**
 * Masks buyer display names / emails / fixture buyer keys into non-PII labels.
 * Guarantees no `@` character or raw contact details ever appear in output.
 */
export function maskBuyerLabel(input: {
  displayName?: string | null;
  emailCiphertext?: string | null;
  buyerKey?: string | null;
  isFixture?: boolean;
}): string {
  if (input.isFixture) {
    const rawKey = (input.buyerKey ?? "").replace(/@/g, "").trim();
    const digitsMatch = rawKey.match(/(\d{1,3})$/);
    if (digitsMatch) {
      return `Demo guest ${digitsMatch[1]!.padStart(2, "0")}`;
    }
    const letters = rawKey
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .slice(-2)
      .map((part) => part[0]!.toUpperCase())
      .join(".");
    return letters ? `Demo guest ${letters}.` : "Demo guest";
  }

  const rawName = (input.displayName ?? "").replace(/@/g, " ").trim();
  if (rawName.length > 0) {
    const parts = rawName.split(/\s+/).filter(Boolean);
    const initials = parts
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join(".");
    if (initials.length > 0) {
      return `Guest ${initials}.`;
    }
  }

  const rawEmail = (input.emailCiphertext ?? "").trim();
  if (rawEmail.length > 0) {
    const localPart = rawEmail.split("@")[0] ?? rawEmail;
    const tokens = localPart.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    const initials = tokens
      .slice(0, 2)
      .map((t) => t[0]!.toUpperCase())
      .join(".");
    if (initials.length > 0) {
      return `Guest ${initials}.`;
    }
  }

  return "Guest";
}

function toScheduleResourceKind(rawType: string): ScheduleResourceKind {
  return rawType.toUpperCase() === "ROOM" ? "ROOM" : "STAFF";
}

function toSchedulePreparedBy(
  rawSurface: string | null | undefined,
): SchedulePreparedBy | undefined {
  if (!rawSurface) return undefined;
  const normalized = rawSurface.toLowerCase();
  if (normalized === "ask_ai") return "ASK_AI";
  if (normalized === "mcp" || normalized === "mcp_streamable_http") return "MCP";
  if (normalized === "web") return "WEB";
  if (normalized === "merchant") return "MERCHANT";
  return undefined;
}

export class ScheduleService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock?: ClockPort,
  ) {}

  async getSchedule(input: { tenantId: string; from: Date; to: Date }): Promise<ScheduleResponse> {
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();

    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
      throw new DomainError(
        "Invalid schedule date range: 'to' must be strictly after 'from'",
        "INVALID_SCHEDULE_RANGE",
        400,
      );
    }

    if (toMs - fromMs > MAX_SCHEDULE_RANGE_MS) {
      throw new DomainError(
        "Schedule query window cannot exceed 14 days",
        "SCHEDULE_RANGE_TOO_LARGE",
        400,
      );
    }

    const now = this.clock ? this.clock.now() : new Date();

    return withTenantTransaction(this.db, input.tenantId as TenantId, async (trx) => {
      // 1. Resources and tenant/location time zone
      const resourceRows = await trx
        .selectFrom("resources")
        .innerJoin("locations", "locations.id", "resources.location_id")
        .where("resources.tenant_id", "=", input.tenantId)
        .where("resources.status", "=", "ACTIVE")
        .select([
          "resources.id",
          "resources.display_name",
          "resources.resource_type",
          "locations.timezone",
        ])
        .orderBy("resources.display_name", "asc")
        .execute();

      const fallbackLocation =
        resourceRows.length === 0
          ? await trx
              .selectFrom("locations")
              .where("tenant_id", "=", input.tenantId)
              .select(["timezone"])
              .executeTakeFirst()
          : undefined;

      const tenantTimeZone = (resourceRows[0]?.timezone ||
        fallbackLocation?.timezone ||
        "America/New_York") as IanaTimeZone;

      const resources: ScheduleResource[] = resourceRows.map((r) => ({
        id: r.id,
        name: r.display_name,
        kind: toScheduleResourceKind(r.resource_type),
        timeZone: (r.timezone || tenantTimeZone) as IanaTimeZone,
      }));

      // 2. Active & overlapping claims
      const blockingClaimRows = await trx
        .selectFrom("resource_claims")
        .where("tenant_id", "=", input.tenantId)
        .where("blocking", "=", true)
        .where("starts_at", "<", input.to)
        .where("ends_at", ">", input.from)
        .select([
          "id",
          "booking_id",
          "claim_source",
          "resource_id",
          "starts_at",
          "ends_at",
          "state",
          "hold_expires_at",
        ])
        .execute();

      const blockingBookingIds = new Set<string>();
      const claimByBookingId = new Map<string, (typeof blockingClaimRows)[number]>();
      const standaloneHoldClaims: Array<(typeof blockingClaimRows)[number]> = [];

      for (const claim of blockingClaimRows) {
        if (claim.booking_id) {
          blockingBookingIds.add(claim.booking_id);
          claimByBookingId.set(claim.booking_id, claim);
        } else if (claim.claim_source !== "DEMO_FIXTURE") {
          standaloneHoldClaims.push(claim);
        }
      }

      // 3. Bookings in range (blocking or terminal COMPLETED / NO_SHOW / CANCELLED)
      const bookingRows = await trx
        .selectFrom("bookings")
        .innerJoin("customers", "customers.id", "bookings.customer_id")
        .innerJoin("booking_quotes", "booking_quotes.id", "bookings.quote_id")
        .innerJoin("service_versions", "service_versions.id", "booking_quotes.service_version_id")
        .where("bookings.tenant_id", "=", input.tenantId)
        .where("bookings.starts_at", "<", input.to)
        .where("bookings.ends_at", ">", input.from)
        .select([
          "bookings.id",
          "bookings.status",
          "bookings.starts_at",
          "bookings.ends_at",
          "bookings.hold_expires_at",
          "bookings.resource_id",
          "customers.display_name_ciphertext",
          "customers.email_ciphertext",
          "service_versions.name as service_name",
        ])
        .orderBy("bookings.starts_at", "asc")
        .execute();

      const relevantBookings = bookingRows.filter(
        (b) => blockingBookingIds.has(b.id) || TERMINAL_VISIBLE_BOOKING_STATUSES.has(b.status),
      );
      const relevantBookingIds = relevantBookings.map((b) => b.id);

      // 4. Batch-load confirmations, payment intents, captures, refunds for visible bookings
      const [confirmations, paymentIntents, captures, refunds] =
        relevantBookingIds.length > 0
          ? await Promise.all([
              trx
                .selectFrom("buyer_confirmations")
                .where("tenant_id", "=", input.tenantId)
                .where("booking_id", "in", relevantBookingIds)
                .select(["booking_id", "prepared_by_surface"])
                .execute(),
              trx
                .selectFrom("payment_intents")
                .where("tenant_id", "=", input.tenantId)
                .where("booking_id", "in", relevantBookingIds)
                .select(["booking_id", "state", "amount_minor"])
                .execute(),
              trx
                .selectFrom("payment_captures")
                .where("tenant_id", "=", input.tenantId)
                .where("booking_id", "in", relevantBookingIds)
                .select(["booking_id", "state", "amount_minor"])
                .execute(),
              trx
                .selectFrom("refund_reservations")
                .where("tenant_id", "=", input.tenantId)
                .where("booking_id", "in", relevantBookingIds)
                .select(["booking_id", "state", "amount_minor"])
                .execute(),
            ])
          : [[], [], [], []];

      const surfaceByBookingId = new Map<string, string | null>();
      for (const c of confirmations) {
        surfaceByBookingId.set(c.booking_id, c.prepared_by_surface);
      }
      const intentByBookingId = new Map<string, (typeof paymentIntents)[number]>();
      for (const pi of paymentIntents) {
        intentByBookingId.set(pi.booking_id, pi);
      }
      const captureByBookingId = new Map<string, (typeof captures)[number]>();
      for (const cap of captures) {
        captureByBookingId.set(cap.booking_id, cap);
      }
      const refundsByBookingId = new Map<string, Array<(typeof refunds)[number]>>();
      for (const ref of refunds) {
        const list = refundsByBookingId.get(ref.booking_id) ?? [];
        list.push(ref);
        refundsByBookingId.set(ref.booking_id, list);
      }

      const events: ScheduleEvent[] = [];

      for (const b of relevantBookings) {
        const claim = claimByBookingId.get(b.id);
        const resourceId = b.resource_id ?? claim?.resource_id;
        if (!resourceId) continue;

        const startsAt = new Date(b.starts_at);
        const endsAt = new Date(b.ends_at);
        const slotDisplay = formatSlotDisplay(startsAt, endsAt, tenantTimeZone);
        const isHold = b.status === "HELD" && Boolean(claim);
        const intent = intentByBookingId.get(b.id);
        const capture = captureByBookingId.get(b.id);
        const bookingRefunds = refundsByBookingId.get(b.id) ?? [];
        const completedRefundMinor = bookingRefunds
          .filter((r) => r.state === "COMPLETED")
          .reduce((acc, r) => acc + BigInt(r.amount_minor), 0n);

        const paymentState = isHold
          ? "NONE"
          : toSchedulePaymentState({
              bookingStatus: b.status,
              paymentIntentState: intent?.state ?? null,
              captureState: capture?.state ?? null,
              capturedMinor: capture?.amount_minor ?? null,
              refundedMinor: completedRefundMinor,
              refundStates: bookingRefunds.map((r) => r.state),
            });

        const holdExpiresDate = b.hold_expires_at ?? claim?.hold_expires_at ?? null;
        const preparedBy = toSchedulePreparedBy(surfaceByBookingId.get(b.id));

        events.push({
          id: isHold ? `hold_${b.id}` : `bk_${b.id}`,
          resourceId,
          startsAt: startsAt.toISOString() as Rfc3339Timestamp,
          endsAt: endsAt.toISOString() as Rfc3339Timestamp,
          display: {
            localStart: slotDisplay.localStart,
            localEnd: slotDisplay.localEnd,
            timeZoneLabel: slotDisplay.timeZoneLabel,
          },
          serviceName: b.service_name,
          kind: isHold ? "HOLD" : "BOOKING",
          status: b.status,
          paymentState,
          ...(isHold && holdExpiresDate
            ? { holdExpiresAt: new Date(holdExpiresDate).toISOString() as Rfc3339Timestamp }
            : {}),
          buyerLabel: maskBuyerLabel({
            displayName: b.display_name_ciphertext,
            emailCiphertext: b.email_ciphertext,
          }),
          ...(preparedBy ? { preparedBy } : {}),
        });
      }

      // 5. Standalone active holds (blocking claims with booking_id IS NULL)
      for (const claim of standaloneHoldClaims) {
        const startsAt = new Date(claim.starts_at);
        const endsAt = new Date(claim.ends_at);
        const slotDisplay = formatSlotDisplay(startsAt, endsAt, tenantTimeZone);
        events.push({
          id: `hold_${claim.id}`,
          resourceId: claim.resource_id,
          startsAt: startsAt.toISOString() as Rfc3339Timestamp,
          endsAt: endsAt.toISOString() as Rfc3339Timestamp,
          display: {
            localStart: slotDisplay.localStart,
            localEnd: slotDisplay.localEnd,
            timeZoneLabel: slotDisplay.timeZoneLabel,
          },
          serviceName: "Reserved Hold",
          kind: "HOLD",
          status: "HELD",
          paymentState: "NONE",
          ...(claim.hold_expires_at
            ? { holdExpiresAt: new Date(claim.hold_expires_at).toISOString() as Rfc3339Timestamp }
            : {}),
          buyerLabel: "Guest Hold",
        });
      }

      // 6. Demo schedule fixtures (judge tenant only; isolated by RLS + tenant_id check)
      const fixtureRows = await trx
        .selectFrom("demo_schedule_fixtures")
        .innerJoin("services", "services.id", "demo_schedule_fixtures.service_id")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("demo_schedule_fixtures.tenant_id", "=", input.tenantId)
        .where("demo_schedule_fixtures.starts_at", "<", input.to)
        .where("demo_schedule_fixtures.ends_at", ">", input.from)
        .select([
          "demo_schedule_fixtures.id",
          "demo_schedule_fixtures.resource_id",
          "demo_schedule_fixtures.starts_at",
          "demo_schedule_fixtures.ends_at",
          "demo_schedule_fixtures.display_status",
          "demo_schedule_fixtures.buyer_key",
          "demo_schedule_fixtures.deposit_paid",
          "service_versions.name as service_name",
        ])
        .orderBy("demo_schedule_fixtures.starts_at", "asc")
        .execute();

      for (const fx of fixtureRows) {
        const startsAt = new Date(fx.starts_at);
        const endsAt = new Date(fx.ends_at);
        const slotDisplay = formatSlotDisplay(startsAt, endsAt, tenantTimeZone);
        events.push({
          id: `fx_${fx.id}`,
          resourceId: fx.resource_id,
          startsAt: startsAt.toISOString() as Rfc3339Timestamp,
          endsAt: endsAt.toISOString() as Rfc3339Timestamp,
          display: {
            localStart: slotDisplay.localStart,
            localEnd: slotDisplay.localEnd,
            timeZoneLabel: slotDisplay.timeZoneLabel,
          },
          serviceName: fx.service_name,
          kind: "DEMO_FIXTURE",
          status: fx.display_status,
          paymentState: toSchedulePaymentState({
            bookingStatus: fx.display_status,
            depositPaidFlag: fx.deposit_paid,
          }),
          buyerLabel: maskBuyerLabel({ buyerKey: fx.buyer_key, isFixture: true }),
        });
      }

      events.sort((a, b) => {
        const timeDiff = new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });

      const resourceTimeRanges: ScheduleResponse["resourceTimeRanges"] = [];

      const revisionDigest = canonicalHash({
        tenantId: input.tenantId,
        tenantTimeZone,
        from: input.from.toISOString(),
        to: input.to.toISOString(),
        resources,
        events,
        resourceTimeRanges,
      });

      return {
        tenantTimeZone,
        scheduleRevision: `rev_${revisionDigest.slice(0, 20)}`,
        generatedAt: now.toISOString() as Rfc3339Timestamp,
        resources,
        events,
        resourceTimeRanges,
      };
    });
  }
}
