import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Database,
  createDatabaseClient,
  getTestDatabaseUrl,
  migrateToLatest,
  withTenantTransaction,
} from "@velvetai/db";
import { DEV_TENANT_ID, JUDGE_TENANT_ID } from "@velvetai/domain";
import {
  BookingId,
  IanaTimeZone,
  LocationId,
  Rfc3339Timestamp,
  ServiceId,
  UserId,
  scheduleResponseSchema,
} from "@velvetai/contracts";
import { Kysely } from "kysely";
import { BookingService } from "../booking-service.js";
import { JudgeResetService } from "../judge/judge-reset-service.js";
import { JudgeRaceTestService } from "../judge/race-test-service.js";
import { maskBuyerLabel, ScheduleService, toSchedulePaymentState } from "../schedule-service.js";

describe("WP 05: ScheduleService & JudgeRaceTestService", () => {
  let db: Kysely<Database>;
  let bookingService: BookingService;
  let scheduleService: ScheduleService;
  let judgeServiceId: string;
  let judgeLocationId: string;
  let judgeResourceId: string;

  const judgeUserId = crypto.randomUUID() as UserId;
  const judgeActor = {
    subject: `auth0|judge-sched-${judgeUserId}`,
    userId: judgeUserId,
    tenantId: JUDGE_TENANT_ID,
    roles: ["JUDGE", "BUYER"],
  };

  beforeAll(async () => {
    db = createDatabaseClient(getTestDatabaseUrl(), { min: 2, max: 15 });
    await migrateToLatest(db);
    bookingService = new BookingService(db);
    scheduleService = new ScheduleService(db);

    const existingSystemJudge = await db
      .selectFrom("app_users")
      .where("oidc_subject", "=", "auth0|system-judge")
      .select(["id"])
      .executeTakeFirst();

    const reset = new JudgeResetService(db);
    await reset.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: existingSystemJudge?.id ?? "01932b10-0000-7000-8000-000000000002",
    });

    const meta = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      const svc = await trx
        .selectFrom("services")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("status", "=", "ACTIVE")
        .select(["id"])
        .executeTakeFirstOrThrow();
      const res = await trx
        .selectFrom("resources")
        .where("tenant_id", "=", JUDGE_TENANT_ID)
        .where("status", "=", "ACTIVE")
        .select(["id", "location_id"])
        .executeTakeFirstOrThrow();
      return { serviceId: svc.id, resourceId: res.id, locationId: res.location_id };
    });

    judgeServiceId = meta.serviceId;
    judgeResourceId = meta.resourceId;
    judgeLocationId = meta.locationId;
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.destroy();
    }
  });

  it("toSchedulePaymentState maps every intent, capture, refund, and booking state deterministically", () => {
    expect(toSchedulePaymentState({ bookingStatus: "HELD" })).toBe("NONE");
    expect(toSchedulePaymentState({ bookingStatus: "EXPIRED" })).toBe("NONE");
    expect(toSchedulePaymentState({ bookingStatus: "CANCELLED" })).toBe("NONE");

    expect(
      toSchedulePaymentState({
        bookingStatus: "COMMITTING",
        paymentIntentState: "ORDER_CREATE_PENDING",
      }),
    ).toBe("AWAITING_PAYER");
    expect(
      toSchedulePaymentState({
        bookingStatus: "REQUIRES_PAYER_ACTION",
        paymentIntentState: "REQUIRES_PAYER_ACTION",
      }),
    ).toBe("AWAITING_PAYER");

    expect(
      toSchedulePaymentState({
        bookingStatus: "CAPTURE_UNCERTAIN",
        paymentIntentState: "CAPTURE_UNCERTAIN",
      }),
    ).toBe("VERIFYING");
    expect(
      toSchedulePaymentState({
        bookingStatus: "COMMITTING",
        paymentIntentState: "CAPTURE_IN_FLIGHT",
      }),
    ).toBe("VERIFYING");
    expect(
      toSchedulePaymentState({
        bookingStatus: "COMMITTING",
        paymentIntentState: "ORDER_CREATE_UNKNOWN",
      }),
    ).toBe("VERIFYING");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        paymentIntentState: "REQUIRES_PAYER_ACTION",
        captureState: "PENDING",
      }),
    ).toBe("VERIFYING");

    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        paymentIntentState: "CAPTURED",
        captureState: "COMPLETED",
        capturedMinor: "2000",
        refundedMinor: "0",
      }),
    ).toBe("PAID");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        depositPaidFlag: true,
      }),
    ).toBe("PAID");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        depositPaidFlag: false,
      }),
    ).toBe("NONE");

    expect(
      toSchedulePaymentState({
        bookingStatus: "PAYMENT_FAILED",
        paymentIntentState: "PAYMENT_FAILED",
      }),
    ).toBe("FAILED");
    expect(
      toSchedulePaymentState({
        bookingStatus: "PAYMENT_WINDOW_EXPIRED",
        paymentIntentState: "PAYMENT_WINDOW_EXPIRED",
      }),
    ).toBe("FAILED");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        captureState: "DECLINED",
      }),
    ).toBe("FAILED");

    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        captureState: "PARTIALLY_REFUNDED",
        capturedMinor: "2000",
        refundedMinor: "1000",
      }),
    ).toBe("PARTIALLY_REFUNDED");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CONFIRMED",
        captureState: "COMPLETED",
        capturedMinor: "2000",
        refundedMinor: "1000",
      }),
    ).toBe("PARTIALLY_REFUNDED");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CANCELLED",
        captureState: "REFUNDED",
        capturedMinor: "2000",
        refundedMinor: "2000",
      }),
    ).toBe("REFUNDED");
    expect(
      toSchedulePaymentState({
        bookingStatus: "CANCELLED",
        captureState: "COMPLETED",
        refundStates: ["COMPLETED"],
      }),
    ).toBe("REFUNDED");
  });

  it("maskBuyerLabel strips emails and emits masked non-PII initials", () => {
    expect(maskBuyerLabel({ displayName: "Aria Chen" })).toBe("Guest A.C.");
    expect(maskBuyerLabel({ emailCiphertext: "maya.patel@example.com" })).toBe("Guest M.P.");
    expect(maskBuyerLabel({ buyerKey: "demo-guest-07", isFixture: true })).toBe("Demo guest 07");
    expect(maskBuyerLabel({ emailCiphertext: "raw@email.com", isFixture: true })).not.toContain(
      "@",
    );
  });

  it("maps bookings, holds, and fixtures with deterministic ETag and rejects >14-day range", async () => {
    const startWindow = new Date(Date.now() + 2 * 86_400_000);
    startWindow.setUTCHours(14, 0, 0, 0);
    const holdStart = new Date(startWindow.getTime() + 5 * 86_400_000 + 3 * 3600_000);

    const hold = await bookingService.prepareBooking(
      JUDGE_TENANT_ID,
      judgeActor,
      "ask-ai",
      {
        serviceId: judgeServiceId as ServiceId,
        locationId: judgeLocationId as LocationId,
        startsAt: holdStart.toISOString() as Rfc3339Timestamp,
        timeZone: "America/New_York" as IanaTimeZone,
        customer: {
          email: "hidden.buyer@example.com",
          displayName: "Nora Patel",
        },
      },
      { resourceId: judgeResourceId as never },
    );

    try {
      const from = new Date(Date.now() - 86_400_000);
      const to = new Date(Date.now() + 10 * 86_400_000);
      const schedule = await scheduleService.getSchedule({
        tenantId: JUDGE_TENANT_ID,
        from,
        to,
      });

      const parsed = scheduleResponseSchema.parse(schedule);
      expect(parsed.resources.length).toBeGreaterThanOrEqual(4);
      const resourceNames = parsed.resources.map((r) => r.name);
      expect(resourceNames).toEqual(
        expect.arrayContaining([
          "Aria (Stylist)",
          "Marco (Barber)",
          "Lena (Therapist)",
          "Studio A (Room)",
        ]),
      );
      expect(parsed.events.some((e) => e.kind === "DEMO_FIXTURE" && e.id.startsWith("fx_"))).toBe(
        true,
      );
      const mappedHold = parsed.events.find((e) => e.id === `hold_${hold.bookingId}`);
      expect(mappedHold).toBeDefined();
      expect(mappedHold?.kind).toBe("HOLD");
      expect(mappedHold?.status).toBe("HELD");
      expect(mappedHold?.paymentState).toBe("NONE");
      expect(mappedHold?.preparedBy).toBe("ASK_AI");
      expect(mappedHold?.buyerLabel).toBe("Guest N.P.");

      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("@");
      expect(serialized).not.toContain('"note"');

      // Same query returns identical deterministic scheduleRevision
      const schedule2 = await scheduleService.getSchedule({
        tenantId: JUDGE_TENANT_ID,
        from,
        to,
      });
      expect(schedule2.scheduleRevision).toBe(schedule.scheduleRevision);

      // Dev tenant never sees judge tenant's hold or fixtures
      const devSchedule = await scheduleService.getSchedule({
        tenantId: DEV_TENANT_ID,
        from,
        to,
      });
      expect(devSchedule.events.find((e) => e.id === `hold_${hold.bookingId}`)).toBeUndefined();
      expect(devSchedule.events.some((e) => e.kind === "DEMO_FIXTURE")).toBe(false);

      // > 14 day range rejected with 400
      await expect(
        scheduleService.getSchedule({
          tenantId: JUDGE_TENANT_ID,
          from: new Date(),
          to: new Date(Date.now() + 15 * 86_400_000),
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      const prepCancel = await bookingService.prepareCancellation(
        JUDGE_TENANT_ID,
        judgeActor,
        hold.bookingId,
      );
      if (prepCancel.cancellationConfirmationToken) {
        await bookingService.commitCancellation(JUDGE_TENANT_ID, judgeActor, hold.bookingId, {
          cancellationConfirmationToken: prepCancel.cancellationConfirmationToken,
          reason: "test cleanup",
        });
      }
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx.deleteFrom("bookings").where("id", "=", hold.bookingId).execute();
      });
    }
  });

  it("JudgeRaceTestService enforces 1 winner / N-1 conflicts under 20 and 50 parallel, leaves zero residue, and blocks when occupied", async () => {
    const raceService = new JudgeRaceTestService(db, { rateLimitWindowMs: 0 });
    const raceStart20 = new Date(Date.now() + 9 * 86_400_000);
    raceStart20.setUTCHours(16, 0, 0, 0);

    // 1. Non-judge tenant -> 403
    await expect(
      raceService.runRaceTest({
        tenantId: DEV_TENANT_ID,
        actor: judgeActor,
        params: { parallel: 20 },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // 2. N = 20 parallel
    const res20 = await raceService.runRaceTest({
      tenantId: JUDGE_TENANT_ID,
      actor: judgeActor,
      params: {
        resourceId: judgeResourceId,
        serviceId: judgeServiceId,
        startsAt: raceStart20.toISOString() as Rfc3339Timestamp,
        parallel: 20,
      },
    });
    expect(res20.attempts).toBe(20);
    expect(res20.succeeded).toBe(1);
    expect(res20.conflicts).toBe(19);
    expect(res20.winnerHoldId).toMatch(/^hold_/);

    // Zero residual blocking claims at raceStart20
    const afterClaims = await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
      return trx
        .selectFrom("resource_claims")
        .where("resource_id", "=", judgeResourceId)
        .where("starts_at", "=", raceStart20)
        .where("blocking", "=", true)
        .select(["id"])
        .execute();
    });
    expect(afterClaims.length).toBe(0);

    // 3. N = 50 parallel
    const raceStart50 = new Date(Date.now() + 10 * 86_400_000);
    raceStart50.setUTCHours(17, 0, 0, 0);
    const res50 = await raceService.runRaceTest({
      tenantId: JUDGE_TENANT_ID,
      actor: judgeActor,
      params: {
        resourceId: judgeResourceId,
        serviceId: judgeServiceId,
        startsAt: raceStart50.toISOString() as Rfc3339Timestamp,
        parallel: 50,
      },
    });
    expect(res50.attempts).toBe(50);
    expect(res50.succeeded).toBe(1);
    expect(res50.conflicts).toBe(49);

    // 4. Existing booking occupies slot -> 0 successes, 20 conflicts
    const occupiedStart = new Date(Date.now() + 11 * 86_400_000);
    occupiedStart.setUTCHours(15, 0, 0, 0);
    const existingHold = await bookingService.prepareBooking(
      JUDGE_TENANT_ID,
      judgeActor,
      "web",
      {
        serviceId: judgeServiceId as ServiceId,
        locationId: judgeLocationId as LocationId,
        startsAt: occupiedStart.toISOString() as Rfc3339Timestamp,
        timeZone: "America/New_York" as IanaTimeZone,
        customer: { email: "existing.buyer@example.com", displayName: "Existing Buyer" },
      },
      { resourceId: judgeResourceId as never },
    );

    try {
      const blockedRes = await raceService.runRaceTest({
        tenantId: JUDGE_TENANT_ID,
        actor: judgeActor,
        params: {
          resourceId: judgeResourceId,
          serviceId: judgeServiceId,
          startsAt: occupiedStart.toISOString() as Rfc3339Timestamp,
          parallel: 20,
        },
      });
      expect(blockedRes.attempts).toBe(20);
      expect(blockedRes.succeeded).toBe(0);
      expect(blockedRes.conflicts).toBe(20);
      expect(blockedRes.winnerHoldId).toBeNull();
    } finally {
      const prepCancel = await bookingService.prepareCancellation(
        JUDGE_TENANT_ID,
        judgeActor,
        existingHold.bookingId as BookingId,
      );
      if (prepCancel.cancellationConfirmationToken) {
        await bookingService.commitCancellation(
          JUDGE_TENANT_ID,
          judgeActor,
          existingHold.bookingId as BookingId,
          {
            cancellationConfirmationToken: prepCancel.cancellationConfirmationToken,
            reason: "cleanup",
          },
        );
      }
      await withTenantTransaction(db, JUDGE_TENANT_ID, async (trx) => {
        await trx.deleteFrom("bookings").where("id", "=", existingHold.bookingId).execute();
      });
    }
  }, 30_000);
});
