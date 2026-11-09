import crypto from "node:crypto";
import { type Kysely, type Database, withTenantTransaction, sql } from "@velvetai/db";
import {
  JUDGE_TENANT_ID,
  JUDGE_SEED_VERSION,
  JUDGE_NAMESPACE,
  JudgeResetInProgressError,
  UnauthorizedTenantAccessError,
} from "@velvetai/domain";
import { buildJudgeSeedPlan, deterministicUuid } from "./seed-plan.js";

export interface JudgeResetStepMetric {
  name: string;
  status: "OK" | "SKIPPED_NOT_AVAILABLE" | "FAILED";
  count?: number;
  ms: number;
  error?: string;
}

export interface JudgeResetSummary {
  retainedPaidBookings: number;
  removedFixtures: number;
  seededFixtures: number;
  skippedConflicts: number;
  seededHistory: number;
  forecastsComputed: number;
  message: string;
}

export interface JudgeResetResult {
  runId: string;
  status: "SUCCEEDED" | "FAILED";
  summary: JudgeResetSummary;
  steps: JudgeResetStepMetric[];
}

export class JudgeResetService {
  constructor(private readonly db: Kysely<Database>) {}

  async resetJudgeTenant(options: {
    tenantId: string;
    requestedBy: string;
    now?: Date;
    timeZone?: string;
  }): Promise<JudgeResetResult> {
    const { tenantId, requestedBy } = options;
    const now = options.now ?? new Date();
    const timeZone = options.timeZone ?? "America/New_York";

    // 0. Defense in Depth: Tenant Isolation Guard
    if (tenantId !== JUDGE_TENANT_ID) {
      throw new UnauthorizedTenantAccessError(
        `Judge operations are strictly prohibited outside the dedicated judge tenant (${JUDGE_TENANT_ID})`,
      );
    }

    const runId = crypto.randomUUID();
    const steps: JudgeResetStepMetric[] = [];

    const recordStep = async (
      name: string,
      fn: () => Promise<{ count?: number; status?: "OK" | "SKIPPED_NOT_AVAILABLE" }>,
    ) => {
      const start = Date.now();
      try {
        const res = await fn();
        steps.push({
          name,
          status: res.status ?? "OK",
          count: res.count,
          ms: Date.now() - start,
        });
      } catch (err: unknown) {
        const errorMsg = (err as Error).message;
        steps.push({
          name,
          status: "FAILED",
          ms: Date.now() - start,
          error: errorMsg,
        });
        throw err;
      }
    };

    return await withTenantTransaction(this.db, JUDGE_TENANT_ID as any, async (trx) => {
      // Step 1: Start & Concurrency Lock Check
      await recordStep("start", async () => {
        const recentRunning = await trx
          .selectFrom("judge_runs")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("status", "=", "RUNNING")
          .where(sql<boolean>`started_at >= ${new Date(Date.now() - 5 * 60_000)}`)
          .selectAll()
          .executeTakeFirst();

        if (recentRunning) {
          throw new JudgeResetInProgressError();
        }

        // Ensure user exists in app_users
        await trx
          .insertInto("app_users")
          .values({
            id: requestedBy,
            oidc_subject: "auth0|system-judge",
            email_ciphertext: "system@velvetai.internal",
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();

        await trx
          .insertInto("judge_runs")
          .values({
            id: runId,
            tenant_id: JUDGE_TENANT_ID,
            seed_version: JUDGE_SEED_VERSION,
            status: "RUNNING",
            started_at: now,
            requested_by: requestedBy,
            steps: JSON.stringify([]),
          })
          .execute();

        return { count: 1 };
      });

      // Step 2: Expire live unconfirmed holds
      let expiredHoldsCount = 0;
      await recordStep("expire_live_holds", async () => {
        const liveHolds = await trx
          .selectFrom("resource_claims")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("state", "=", "HELD")
          .where("claim_source", "=", "BOOKING")
          .select(["id", "booking_id"])
          .execute();

        expiredHoldsCount = liveHolds.length;

        for (const claim of liveHolds) {
          await trx
            .updateTable("resource_claims")
            .set({ state: "EXPIRED", blocking: false })
            .where("tenant_id", "=", JUDGE_TENANT_ID)
            .where("id", "=", claim.id)
            .execute();

          if (claim.booking_id) {
            await trx
              .updateTable("bookings")
              .set((eb) => ({
                status: "EXPIRED",
                version: eb("version", "+", 1),
              }))
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("id", "=", claim.booking_id)
              .execute();
          }
        }

        return { count: expiredHoldsCount };
      });

      // Step 3: Cancel unpaid live bookings
      let cancelledUnpaidCount = 0;
      await recordStep("cancel_unpaid_live_bookings", async () => {
        const unpaidBookings = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("status", "in", ["COMMITTING", "REQUIRES_PAYER_ACTION", "CAPTURE_UNCERTAIN"])
          .select(["id"])
          .execute();

        for (const b of unpaidBookings) {
          // Check if any completed capture exists
          const hasCapture = await trx
            .selectFrom("payment_captures")
            .where("tenant_id", "=", JUDGE_TENANT_ID)
            .where("booking_id", "=", b.id)
            .where("state", "=", "COMPLETED")
            .select(["id"])
            .executeTakeFirst();

          if (!hasCapture) {
            await trx
              .updateTable("bookings")
              .set((eb) => ({
                status: "PAYMENT_FAILED",
                version: eb("version", "+", 1),
              }))
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("id", "=", b.id)
              .execute();

            await trx
              .updateTable("resource_claims")
              .set({ state: "RELEASED", blocking: false })
              .where("tenant_id", "=", JUDGE_TENANT_ID)
              .where("booking_id", "=", b.id)
              .execute();

            cancelledUnpaidCount++;
          }
        }

        return { count: cancelledUnpaidCount };
      });

      // Step 4: Retain paid bookings (audit & count)
      let retainedPaidCount = 0;
      await recordStep("retain_paid_bookings", async () => {
        const paidBookings = await trx
          .selectFrom("bookings")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("status", "=", "CONFIRMED")
          .select(["id"])
          .execute();

        retainedPaidCount = paidBookings.length;
        return { count: retainedPaidCount };
      });

      // Step 5: Remove prior demo fixtures and synthetic history
      let removedFixturesCount = 0;
      await recordStep("remove_fixtures", async () => {
        const fixtures = await trx
          .selectFrom("demo_schedule_fixtures")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .select(["id", "claim_id"])
          .execute();

        removedFixturesCount = fixtures.length;

        // Delete fixture resource claims
        await trx
          .deleteFrom("resource_claims")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .where("claim_source", "=", "DEMO_FIXTURE")
          .execute();

        // Delete fixtures
        await trx
          .deleteFrom("demo_schedule_fixtures")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .execute();

        // Delete synthetic history
        await trx
          .deleteFrom("synthetic_history")
          .where("tenant_id", "=", JUDGE_TENANT_ID)
          .execute();

        return { count: removedFixturesCount };
      });

      // Generate pure deterministic plan
      const plan = buildJudgeSeedPlan({ now, timeZone, seed: JUDGE_SEED_VERSION });

      // Step 6: Upsert catalog (merchant, resources, services, availability)
      await recordStep("upsert_catalog", async () => {
        // Ensure tenant
        await trx
          .insertInto("tenants")
          .values({
            id: JUDGE_TENANT_ID,
            name: plan.merchant.name,
            default_currency: "USD",
            status: "ACTIVE",
          })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet({ name: plan.merchant.name, status: "ACTIVE" }),
          )
          .execute();

        // Ensure location
        await trx
          .insertInto("locations")
          .values({
            id: plan.merchant.locationId,
            tenant_id: JUDGE_TENANT_ID,
            name: plan.merchant.locationName,
            timezone: plan.timeZone,
            status: "ACTIVE",
          })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet({
              name: plan.merchant.locationName,
              timezone: plan.timeZone,
              status: "ACTIVE",
            }),
          )
          .execute();

        // Standard cancellation policy ID
        const policyId = deterministicUuid(JUDGE_NAMESPACE, "policy:standard-24h");

        // Upsert 4 resources and their availability rules
        for (const res of plan.resources) {
          await trx
            .insertInto("resources")
            .values({
              id: res.id,
              tenant_id: JUDGE_TENANT_ID,
              location_id: plan.merchant.locationId,
              resource_type: res.resourceType,
              display_name: res.name,
              status: "ACTIVE",
            })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                display_name: res.name,
                status: "ACTIVE",
              }),
            )
            .execute();

          const ruleId = deterministicUuid(JUDGE_NAMESPACE, `avail-rule:${res.id}`);
          await trx
            .insertInto("availability_rules")
            .values({
              id: ruleId,
              tenant_id: JUDGE_TENANT_ID,
              resource_id: res.id,
              timezone: plan.timeZone,
              recurrence_rule: "RRULE:FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16,17,18",
              effective_from: new Date("2026-01-01T00:00:00.000Z"),
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }

        // Upsert 5 services and versions
        for (const svc of plan.services) {
          await trx
            .insertInto("services")
            .values({
              id: svc.id,
              tenant_id: JUDGE_TENANT_ID,
              status: "ACTIVE",
              current_version_id: null,
            })
            .onConflict((oc) =>
              oc.columns(["tenant_id", "id"]).doUpdateSet({
                status: "ACTIVE",
              }),
            )
            .execute();

          await trx
            .insertInto("service_versions")
            .values({
              id: svc.versionId,
              tenant_id: JUDGE_TENANT_ID,
              service_id: svc.id,
              version: 1,
              name: svc.name,
              description: svc.description,
              duration_minutes: svc.durationMinutes,
              buffer_before_minutes: svc.bufferBeforeMinutes,
              buffer_after_minutes: svc.bufferAfterMinutes,
              price_minor: svc.priceMinor,
              base_deposit_minor: svc.depositMinor,
              currency: svc.currency,
              cancellation_policy_id: policyId,
              published_at: now,
            })
            .onConflict((oc) =>
              oc.columns(["tenant_id", "id"]).doUpdateSet({
                name: svc.name,
                description: svc.description,
                duration_minutes: svc.durationMinutes,
                price_minor: svc.priceMinor,
                base_deposit_minor: svc.depositMinor,
                currency: svc.currency,
                cancellation_policy_id: policyId,
              }),
            )
            .execute();

          await trx
            .updateTable("services")
            .set({ current_version_id: svc.versionId })
            .where("tenant_id", "=", JUDGE_TENANT_ID)
            .where("id", "=", svc.id)
            .execute();
        }

        return { count: plan.services.length };
      });

      // Step 7: Seed synthetic history
      await recordStep("seed_history", async () => {
        for (const item of plan.history) {
          await trx
            .insertInto("synthetic_history")
            .values({
              id: item.id,
              tenant_id: JUDGE_TENANT_ID,
              judge_run_id: runId,
              resource_id: item.resourceId,
              service_id: item.serviceId,
              starts_at: item.startsAt,
              ends_at: item.endsAt,
              outcome: item.outcome,
              lead_time_hours: item.leadTimeHours,
              deposit_paid: item.depositPaid,
              buyer_key: item.buyerKey,
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();
        }

        return { count: plan.history.length };
      });

      // Step 8: Seed fixtures (with GiST conflict skipping)
      let seededFixturesCount = 0;
      let skippedConflictsCount = 0;

      await recordStep("seed_fixtures", async () => {
        for (const fixture of plan.fixtures) {
          const occupiesTime =
            fixture.displayStatus === "CONFIRMED" ||
            fixture.displayStatus === "CHECKED_IN" ||
            fixture.displayStatus === "COMPLETED";

          let claimId: string | null = null;

          if (occupiesTime) {
            claimId = crypto.randomUUID();

            // Use PostgreSQL SAVEPOINT to catch GiST 23P01 conflict without aborting transaction
            await sql`SAVEPOINT fixture_claim_savepoint`.execute(trx);
            try {
              await trx
                .insertInto("resource_claims")
                .values({
                  id: claimId,
                  tenant_id: JUDGE_TENANT_ID,
                  booking_id: null,
                  claim_source: "DEMO_FIXTURE",
                  resource_id: fixture.resourceId,
                  starts_at: fixture.startsAt,
                  ends_at: fixture.endsAt,
                  blocked_during: sql`tstzrange(${fixture.startsAt.toISOString()}::timestamptz, ${fixture.endsAt.toISOString()}::timestamptz, '[)')`,
                  state: "CONFIRMED",
                  blocking: true,
                  hold_expires_at: null,
                  expires_at: null,
                })
                .execute();

              await sql`RELEASE SAVEPOINT fixture_claim_savepoint`.execute(trx);
            } catch (err: unknown) {
              await sql`ROLLBACK TO SAVEPOINT fixture_claim_savepoint`.execute(trx);
              const pgErr = err as { code?: string; message?: string };
              if (pgErr.code === "23P01" || pgErr.message?.includes("no_overlapping_claims")) {
                skippedConflictsCount++;
                continue; // Skip this fixture
              }
              throw err; // Re-throw any unexpected error
            }
          }

          await trx
            .insertInto("demo_schedule_fixtures")
            .values({
              id: fixture.id,
              tenant_id: JUDGE_TENANT_ID,
              judge_run_id: runId,
              resource_id: fixture.resourceId,
              service_id: fixture.serviceId,
              starts_at: fixture.startsAt,
              ends_at: fixture.endsAt,
              display_status: fixture.displayStatus,
              buyer_key: fixture.buyerKey,
              deposit_paid: fixture.depositPaid,
              claim_id: claimId,
            })
            .onConflict((oc) => oc.column("id").doNothing())
            .execute();

          seededFixturesCount++;
        }

        return { count: seededFixturesCount };
      });

      // Step 9: Compute forecasts (WP 06 feature-detection placeholder)
      await recordStep("compute_forecasts", async () => {
        return { status: "SKIPPED_NOT_AVAILABLE", count: 0 };
      });

      // Step 10: Finish & Summary
      const summary: JudgeResetSummary = {
        retainedPaidBookings: retainedPaidCount,
        removedFixtures: removedFixturesCount,
        seededFixtures: seededFixturesCount,
        skippedConflicts: skippedConflictsCount,
        seededHistory: plan.history.length,
        forecastsComputed: 0,
        message: `${retainedPaidCount} paid sandbox bookings kept (payments can't be deleted); seeded ${seededFixturesCount} demo fixtures and ${plan.history.length} historical appointments.`,
      };

      await trx
        .updateTable("judge_runs")
        .set({
          status: "SUCCEEDED",
          finished_at: new Date(),
          steps: JSON.stringify(steps),
          summary: JSON.stringify(summary),
        })
        .where("id", "=", runId)
        .execute();

      return {
        runId,
        status: "SUCCEEDED",
        summary,
        steps,
      };
    });
  }

  async getRun(runId: string): Promise<JudgeResetResult | null> {
    const row = await this.db
      .selectFrom("judge_runs")
      .where("id", "=", runId)
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .selectAll()
      .executeTakeFirst();

    if (!row) return null;

    return {
      runId: row.id,
      status: row.status as "SUCCEEDED" | "FAILED",
      steps: typeof row.steps === "string" ? JSON.parse(row.steps) : ((row.steps as any) ?? []),
      summary:
        typeof row.summary === "string" ? JSON.parse(row.summary) : ((row.summary as any) ?? null),
    };
  }

  async getLatestRun(): Promise<JudgeResetResult | null> {
    const row = await this.db
      .selectFrom("judge_runs")
      .where("tenant_id", "=", JUDGE_TENANT_ID)
      .orderBy("started_at", "desc")
      .selectAll()
      .limit(1)
      .executeTakeFirst();

    if (!row) return null;

    return {
      runId: row.id,
      status: row.status as "SUCCEEDED" | "FAILED",
      steps: typeof row.steps === "string" ? JSON.parse(row.steps) : ((row.steps as any) ?? []),
      summary:
        typeof row.summary === "string" ? JSON.parse(row.summary) : ((row.summary as any) ?? null),
    };
  }
}
