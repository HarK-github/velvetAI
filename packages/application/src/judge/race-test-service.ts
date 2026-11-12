import crypto from "node:crypto";
import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { JUDGE_TENANT_ID } from "@velvetai/domain";
import {
  BookingId,
  DomainError,
  IanaTimeZone,
  LocationId,
  PrepareBookingResponse,
  RaceTestInput,
  RaceTestResponse,
  ResourceId,
  Rfc3339Timestamp,
  ServiceId,
  SlotUnavailableError,
  TenantId,
  UserId,
} from "@velvetai/contracts";
import { BookingActor, BookingService, formatSlotDisplay } from "../booking-service.js";
import type { ClockPort } from "../ports.js";

export const DEFAULT_RACE_TEST_RATE_LIMIT_WINDOW_MS = 30_000;

export class RaceTestRateLimitError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Race test is rate-limited to 1 run per 30s. Retry after ${retryAfterSeconds}s.`,
      "rate_limit_exceeded",
      429,
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ConcurrentHoldRaceParams {
  bookingService: BookingService;
  tenantId: TenantId;
  serviceId: ServiceId;
  locationId: LocationId;
  resourceId?: ResourceId;
  startsAt: Rfc3339Timestamp;
  timeZone: IanaTimeZone;
  parallel: number;
  actorForAttempt: (attemptIndex: number) => BookingActor;
  clientIdForAttempt: (attemptIndex: number) => string;
  customerForAttempt: (attemptIndex: number) => { email: string; displayName: string };
}

export interface ConcurrentHoldRaceOutcome {
  attempts: number;
  succeeded: number;
  conflicts: number;
  unexpectedErrors: Array<{ attemptIndex: number; error: unknown }>;
  winnerBookingId: BookingId | null;
  winnerAttemptIndex: number | null;
  createdBookingIds: BookingId[];
  probeEmails: string[];
  durationMs: number;
}

/**
 * Runs `parallel` concurrent production hold attempts (`BookingService.prepareBooking`,
 * which executes `insertBlockingResourceClaim` inside its own transaction/connection).
 * Reused by both WP 05 `POST /v1/judge/race-test` and WP 07 Abuse Lab L1.
 */
export async function executeConcurrentHoldRace(
  params: ConcurrentHoldRaceParams,
): Promise<ConcurrentHoldRaceOutcome> {
  const startedMs = Date.now();
  const customers = Array.from({ length: params.parallel }, (_, i) => params.customerForAttempt(i));

  const results = await Promise.allSettled(
    customers.map((customer, i) =>
      params.bookingService.prepareBooking(
        params.tenantId,
        params.actorForAttempt(i),
        params.clientIdForAttempt(i),
        {
          serviceId: params.serviceId,
          locationId: params.locationId,
          startsAt: params.startsAt,
          timeZone: params.timeZone,
          customer,
        },
        params.resourceId ? { resourceId: params.resourceId } : undefined,
      ),
    ),
  );

  let succeeded = 0;
  let conflicts = 0;
  const unexpectedErrors: Array<{ attemptIndex: number; error: unknown }> = [];
  let winnerBookingId: BookingId | null = null;
  let winnerAttemptIndex: number | null = null;
  const createdBookingIds: BookingId[] = [];

  results.forEach((res: PromiseSettledResult<PrepareBookingResponse>, idx) => {
    if (res.status === "fulfilled") {
      succeeded += 1;
      createdBookingIds.push(res.value.bookingId);
      if (!winnerBookingId) {
        winnerBookingId = res.value.bookingId;
        winnerAttemptIndex = idx;
      }
      return;
    }

    const reason = res.reason;
    if (
      reason instanceof SlotUnavailableError ||
      (reason instanceof DomainError && reason.code === "slot_unavailable" && reason.status === 409)
    ) {
      conflicts += 1;
      return;
    }

    unexpectedErrors.push({ attemptIndex: idx, error: reason });
  });

  return {
    attempts: params.parallel,
    succeeded,
    conflicts,
    unexpectedErrors,
    winnerBookingId,
    winnerAttemptIndex,
    createdBookingIds,
    probeEmails: customers.map((c) => c.email),
    durationMs: Math.max(0, Date.now() - startedMs),
  };
}

export class JudgeRaceTestService {
  private readonly bookingService: BookingService;
  private readonly lastRunAtByActor = new Map<string, number>();
  private readonly rateLimitWindowMs: number;

  constructor(
    private readonly db: Kysely<Database>,
    options?: { clock?: ClockPort; rateLimitWindowMs?: number },
  ) {
    this.bookingService = new BookingService(db, undefined, options?.clock);
    this.rateLimitWindowMs = options?.rateLimitWindowMs ?? DEFAULT_RACE_TEST_RATE_LIMIT_WINDOW_MS;
  }

  async runRaceTest(input: {
    tenantId: string;
    actor: BookingActor;
    params: RaceTestInput;
  }): Promise<RaceTestResponse> {
    if (input.actor.subject.endsWith("@clients") || input.actor.subject.startsWith("client|")) {
      throw new DomainError(
        "M2M clients cannot trigger the judge race test. Human judge required.",
        "HUMAN_JUDGE_REQUIRED",
        403,
      );
    }

    if (input.tenantId !== JUDGE_TENANT_ID) {
      throw new DomainError(
        `Race test is strictly restricted to the dedicated judge tenant (${JUDGE_TENANT_ID}).`,
        "UNAUTHORIZED_TENANT_ACCESS",
        403,
      );
    }

    const rateKey = `${input.tenantId}:${input.actor.userId}`;
    const nowMs = Date.now();
    const prevRunAt = this.lastRunAtByActor.get(rateKey);
    if (prevRunAt !== undefined) {
      const elapsed = nowMs - prevRunAt;
      if (elapsed < this.rateLimitWindowMs) {
        const retryAfter = Math.max(1, Math.ceil((this.rateLimitWindowMs - elapsed) / 1000));
        throw new RaceTestRateLimitError(retryAfter);
      }
    }
    this.lastRunAtByActor.set(rateKey, nowMs);

    try {
      const resolved = await this.resolveTarget(input.params);
      const parallel = input.params.parallel ?? 20;
      const runTag = crypto.randomBytes(4).toString("hex");
      const buyerActors = Array.from({ length: parallel }, (_, i) => ({
        subject: `auth0|race-buyer-${runTag}-${i}`,
        userId: crypto.randomUUID() as UserId,
        tenantId: JUDGE_TENANT_ID,
        roles: ["BUYER"],
      }));

      const outcome = await executeConcurrentHoldRace({
        bookingService: this.bookingService,
        tenantId: JUDGE_TENANT_ID,
        serviceId: resolved.serviceId,
        locationId: resolved.locationId,
        resourceId: resolved.resourceId,
        startsAt: resolved.startsAt,
        timeZone: resolved.timeZone,
        parallel,
        actorForAttempt: (i) => buyerActors[i]!,
        clientIdForAttempt: (i) => `race-probe-${runTag}-${i}`,
        customerForAttempt: (i) => ({
          email: `probe-race-${runTag}-${i}@abuse-lab.velvetai.local`,
          displayName: `Race Buyer ${i + 1}`,
        }),
      });

      if (
        outcome.unexpectedErrors.length > 0 &&
        outcome.succeeded === 0 &&
        outcome.conflicts === 0
      ) {
        const firstErr = outcome.unexpectedErrors[0]!.error;
        if (firstErr instanceof DomainError) {
          throw firstErr;
        }
        throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
      }

      // Immediately release any winner hold through the normal cancellation release path,
      // then clean up synthetic race probe rows so zero schedule residue remains.
      await this.releaseAndCleanupProbe({
        createdBookingIds: outcome.createdBookingIds,
        probeEmails: outcome.probeEmails,
        winnerAttemptIndex: outcome.winnerAttemptIndex,
        buyerActors,
        fallbackActor: input.actor,
      });

      const endsAt = new Date(
        new Date(resolved.startsAt).getTime() + resolved.durationMinutes * 60_000,
      );
      const display = formatSlotDisplay(new Date(resolved.startsAt), endsAt, resolved.timeZone);

      return {
        attempts: outcome.attempts,
        succeeded: outcome.succeeded,
        conflicts: outcome.conflicts,
        winnerHoldId: outcome.winnerBookingId ? `hold_${outcome.winnerBookingId}` : null,
        resourceId: resolved.resourceId,
        serviceId: resolved.serviceId,
        serviceName: resolved.serviceName,
        startsAt: resolved.startsAt,
        endsAt: endsAt.toISOString() as Rfc3339Timestamp,
        display: {
          localStart: display.localStart,
          localEnd: display.localEnd,
          timeZoneLabel: display.timeZoneLabel,
        },
        durationMs: outcome.durationMs,
      };
    } catch (err) {
      // Do not consume rate limit window when validation/input lookup fails before execution
      if (err instanceof DomainError && (err.status === 400 || err.status === 404)) {
        this.lastRunAtByActor.delete(rateKey);
      }
      throw err;
    }
  }

  private async resolveTarget(params: RaceTestInput): Promise<{
    serviceId: ServiceId;
    serviceName: string;
    durationMinutes: number;
    locationId: LocationId;
    resourceId: ResourceId;
    timeZone: IanaTimeZone;
    startsAt: Rfc3339Timestamp;
  }> {
    return withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      let resourceQuery = trx
        .selectFrom("resources")
        .innerJoin("locations", "locations.id", "resources.location_id")
        .where("resources.tenant_id", "=", JUDGE_TENANT_ID)
        .where("resources.status", "=", "ACTIVE");

      if (params.resourceId) {
        resourceQuery = resourceQuery.where("resources.id", "=", params.resourceId);
      }

      const resourceRow = await resourceQuery
        .select(["resources.id", "resources.location_id", "locations.timezone"])
        .orderBy("resources.display_name", "asc")
        .executeTakeFirst();

      if (!resourceRow) {
        throw new DomainError(
          "Target resource was not found in the judge tenant",
          "RESOURCE_NOT_FOUND",
          404,
        );
      }

      let serviceQuery = trx
        .selectFrom("services")
        .innerJoin("service_versions", "service_versions.id", "services.current_version_id")
        .where("services.tenant_id", "=", JUDGE_TENANT_ID)
        .where("services.status", "=", "ACTIVE");

      if (params.serviceId) {
        serviceQuery = serviceQuery.where("services.id", "=", params.serviceId);
      }

      const serviceRow = await serviceQuery
        .select(["services.id", "service_versions.name", "service_versions.duration_minutes"])
        .orderBy("service_versions.name", "asc")
        .executeTakeFirst();

      if (!serviceRow) {
        throw new DomainError(
          "Target service was not found in the judge tenant",
          "SERVICE_NOT_FOUND",
          404,
        );
      }

      const timeZone = (resourceRow.timezone || "America/New_York") as IanaTimeZone;
      const defaultStart = new Date(Date.now() + 2 * 24 * 60 * 60_000);
      defaultStart.setUTCMinutes(0, 0, 0);
      const startsAt = (params.startsAt ?? defaultStart.toISOString()) as Rfc3339Timestamp;

      return {
        serviceId: serviceRow.id as ServiceId,
        serviceName: serviceRow.name,
        durationMinutes: serviceRow.duration_minutes,
        locationId: resourceRow.location_id as LocationId,
        resourceId: resourceRow.id as ResourceId,
        timeZone,
        startsAt,
      };
    });
  }

  private async releaseAndCleanupProbe(input: {
    createdBookingIds: BookingId[];
    probeEmails: string[];
    winnerAttemptIndex: number | null;
    buyerActors: BookingActor[];
    fallbackActor: BookingActor;
  }): Promise<void> {
    for (const bookingId of input.createdBookingIds) {
      const releaseActor =
        input.winnerAttemptIndex !== null
          ? (input.buyerActors[input.winnerAttemptIndex] ?? input.fallbackActor)
          : input.fallbackActor;
      try {
        const prep = await this.bookingService.prepareCancellation(
          JUDGE_TENANT_ID,
          releaseActor,
          bookingId,
        );
        if (prep.cancellationConfirmationToken) {
          await this.bookingService.commitCancellation(JUDGE_TENANT_ID, releaseActor, bookingId, {
            cancellationConfirmationToken: prep.cancellationConfirmationToken,
            reason: "Judge race-test immediate cleanup",
          });
        }
      } catch {
        // Fallback DB cleanup below removes any transient probe rows if cancellation failed
      }
    }

    await withTenantTransaction(this.db, JUDGE_TENANT_ID, async (trx) => {
      if (input.createdBookingIds.length > 0) {
        const tracked = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", input.createdBookingIds)
          .select(["quote_id"])
          .execute();
        const quoteIds = tracked.map((b) => b.quote_id);

        await trx
          .deleteFrom("outbox_events")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("aggregate_type", "=", "booking")
          .where("aggregate_id", "in", input.createdBookingIds)
          .execute();

        await trx
          .deleteFrom("audit_events")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("resource_id", "in", input.createdBookingIds)
          .execute();

        await trx
          .deleteFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("id", "in", input.createdBookingIds)
          .execute();

        if (quoteIds.length > 0) {
          await trx
            .deleteFrom("booking_quotes")
            .where("tenant_id", "=", JUDGE_TENANT_ID)
            .where("id", "in", quoteIds)
            .execute();
        }
      }

      if (input.probeEmails.length > 0) {
        await trx
          .deleteFrom("customers")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("email_ciphertext", "in", input.probeEmails)
          .execute();
      }
    });
  }
}
