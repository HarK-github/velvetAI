import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { formatSlotDisplay } from "./booking-service.js";
import {
  AvailabilityResponse,
  AvailableSlot,
  TenantId,
  ServiceId,
  LocationId,
  ResourceId,
  CurrencyCode,
  MoneyMinor,
  IanaTimeZone,
  Rfc3339Timestamp,
} from "@velvetai/contracts";

export interface GetAvailabilityOptions {
  tenantId: TenantId;
  serviceId: ServiceId;
  locationId?: LocationId;
  from?: Date;
  to?: Date;
  timeZone?: IanaTimeZone;
}

/**
 * Accurately calculates UTC Date for a local YYYY-MM-DD HH:mm:ss in a specified IANA timezone,
 * correctly handling DST transitions.
 */
function getUtcForLocalTime(dateStr: string, timeStr: string, timeZone: string): Date {
  const guess = new Date(`${dateStr}T${timeStr}Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  let offsetMs = 0;
  for (let i = 0; i < 3; i++) {
    const current = new Date(guess.getTime() - offsetMs);
    const parts = formatter.formatToParts(current);
    const p = Object.fromEntries(parts.map((pt) => [pt.type, pt.value]));
    const formattedIso = `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}Z`;
    const localParsed = new Date(formattedIso);
    const diff = localParsed.getTime() - guess.getTime();
    if (diff === 0) {
      return current;
    }
    offsetMs += diff;
  }
  return new Date(guess.getTime() - offsetMs);
}

export class AvailabilityService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Authoritative PostgreSQL-backed availability calculation per Specification v1.1 Amendment:
   * 1. Reads published service requirements and location timezone
   * 2. Matches active resources and availability rules
   * 3. Subtracts active blocking resource claims (including HELD, COMMITTING, CONFIRMED)
   * 4. Enforces service buffers (bufferBeforeMinutes and bufferAfterMinutes)
   * 5. Uses half-open intervals [starts_at, ends_at)
   * 6. Returns schedule revision and authoritative UTC/local times
   * 7. Omit simulated fill probabilities in production
   */
  async getAvailability(options: GetAvailabilityOptions): Promise<AvailabilityResponse> {
    const now = new Date();
    const generatedAt = now.toISOString() as Rfc3339Timestamp;

    return await withTenantTransaction(this.db, options.tenantId, async (trx) => {
      // 1. Fetch active service and published current version
      const service = await trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.tenant_id", "=", options.tenantId)
        .where("services.id", "=", options.serviceId)
        .where("services.status", "=", "ACTIVE")
        .selectAll("service_versions")
        .executeTakeFirst();

      if (!service) {
        return { scheduleRevision: 0, generatedAt, slots: [] };
      }

      // 2. Fetch location for timezone
      let locationQuery = trx
        .selectFrom("locations")
        .where("tenant_id", "=", options.tenantId)
        .where("status", "=", "ACTIVE");

      if (options.locationId) {
        locationQuery = locationQuery.where("id", "=", options.locationId);
      }

      const location = await locationQuery.selectAll().executeTakeFirst();
      if (!location) {
        return { scheduleRevision: 0, generatedAt, slots: [] };
      }

      const effectiveTimeZone = (options.timeZone || location.timezone || "UTC") as IanaTimeZone;

      // 3. Determine time window
      // Default: from now (rounded to next 15m) to 24h ahead if not provided
      let windowFrom = options.from;
      let windowTo = options.to;

      if (!windowFrom) {
        // Start of today in effective timezone
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: effectiveTimeZone }).format(
          now,
        );
        windowFrom = getUtcForLocalTime(todayStr, "09:00:00", effectiveTimeZone);
      }

      if (!windowTo) {
        // End of window: 24 hours after windowFrom
        windowTo = new Date(windowFrom.getTime() + 24 * 60 * 60_000);
      }

      if (windowFrom >= windowTo) {
        return { scheduleRevision: 1, generatedAt, slots: [] };
      }

      // 4. Fetch active resources for this location
      const resources = await trx
        .selectFrom("resources")
        .where("tenant_id", "=", options.tenantId)
        .where("location_id", "=", location.id)
        .where("status", "=", "ACTIVE")
        .selectAll()
        .execute();

      if (resources.length === 0) {
        return { scheduleRevision: 1, generatedAt, slots: [] };
      }

      const resourceIds = resources.map((r) => r.id);

      // 5. Fetch active blocking claims that overlap with the extended search window
      // Max buffer is needed to catch adjacent appointments that encroach
      const maxBufferMs =
        Math.max(service.buffer_before_minutes, service.buffer_after_minutes, 60) * 60_000;
      const searchStart = new Date(windowFrom.getTime() - maxBufferMs);
      const searchEnd = new Date(windowTo.getTime() + maxBufferMs);

      const claims = await trx
        .selectFrom("resource_claims")
        .where("tenant_id", "=", options.tenantId)
        .where("resource_id", "in", resourceIds)
        .where("blocking", "=", true)
        .where("starts_at", "<", searchEnd)
        .where("ends_at", ">", searchStart)
        .select(["id", "resource_id", "starts_at", "ends_at", "state"])
        .execute();

      // 6. Generate candidate slots within operating hours for each day
      const durationMs = service.duration_minutes * 60_000;
      const bufferBeforeMs = service.buffer_before_minutes * 60_000;
      const bufferAfterMs = service.buffer_after_minutes * 60_000;

      // Iterate day-by-day in effective timezone
      const slots: AvailableSlot[] = [];
      const localTimeFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: effectiveTimeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      // Daily operating hours: 09:00 to 17:00
      const cursor = new Date(windowFrom);
      const visitedDays = new Set<string>();

      while (cursor < windowTo) {
        const dayStr = new Intl.DateTimeFormat("en-CA", { timeZone: effectiveTimeZone }).format(
          cursor,
        );
        if (!visitedDays.has(dayStr)) {
          visitedDays.add(dayStr);

          const dayOpenUtc = getUtcForLocalTime(dayStr, "09:00:00", effectiveTimeZone);
          const dayCloseUtc = getUtcForLocalTime(dayStr, "17:00:00", effectiveTimeZone);

          // Generate candidate slots on step intervals (30 minutes)
          const stepMs = Math.min(30 * 60_000, durationMs);
          let slotCandidateStart = dayOpenUtc.getTime();

          while (slotCandidateStart + durationMs <= dayCloseUtc.getTime()) {
            const slotStart = new Date(slotCandidateStart);
            const slotEnd = new Date(slotCandidateStart + durationMs);

            // Must fall within the requested [windowFrom, windowTo) interval
            if (slotStart >= windowFrom && slotEnd <= windowTo) {
              // Block window required for this slot: [slotStart - bufferBefore, slotEnd + bufferAfter)
              const requiredBlockStart = new Date(slotStart.getTime() - bufferBeforeMs);
              const requiredBlockEnd = new Date(slotEnd.getTime() + bufferAfterMs);

              // Find an active resource that is NOT blocked
              for (const resource of resources) {
                const hasConflict = claims.some((c) => {
                  if (c.resource_id !== resource.id) return false;
                  // Half-open interval overlap: [A, B) overlaps with [C, D) iff A < D && B > C
                  const claimStart = new Date(c.starts_at);
                  const claimEnd = new Date(c.ends_at);
                  return claimStart < requiredBlockEnd && claimEnd > requiredBlockStart;
                });

                if (!hasConflict) {
                  const localStartsAt = localTimeFormatter.format(slotStart);
                  const display = formatSlotDisplay(slotStart, slotEnd, effectiveTimeZone);
                  slots.push({
                    startsAt: slotStart.toISOString() as Rfc3339Timestamp,
                    endsAt: slotEnd.toISOString() as Rfc3339Timestamp,
                    localStartsAt,
                    timeZone: effectiveTimeZone,
                    resourceId: resource.id as ResourceId,
                    price: {
                      valueMinor: String(service.price_minor) as MoneyMinor,
                      currency: service.currency as CurrencyCode,
                    },
                    depositPreview: {
                      valueMinor: String(service.base_deposit_minor) as MoneyMinor,
                      currency: service.currency as CurrencyCode,
                    },
                    display,
                  });
                  // Once an available resource is assigned to this time slot, move to next slot
                  break;
                }
              }
            }

            slotCandidateStart += stepMs;
          }
        }

        // Advance cursor by 1 day
        cursor.setDate(cursor.getDate() + 1);
      }

      // Schedule revision based on claims count + resource count + 1
      const scheduleRevision = claims.length + resources.length + 1;

      return {
        scheduleRevision,
        generatedAt,
        serviceName: service.name,
        timeZone: effectiveTimeZone,
        slots,
      };
    });
  }
}
