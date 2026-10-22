import { Kysely, sql } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { createLogger } from "@velvetai/observability";
import crypto from "node:crypto";

export interface HoldReaperResult {
  reapedCount: number;
}

export class HoldReaperProcessor {
  private readonly logger = createLogger({ name: "hold-reaper" });

  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Reaps expired booking holds atomically per Specification v1.1 Amendment Section B.4:
   * 1. Selects expired claims with FOR UPDATE SKIP LOCKED
   * 2. Transitions state to EXPIRED
   * 3. Releases blocking flag (blocking = false)
   * 4. Increments booking row version
   * 5. Appends outbox event and audit event in the same transaction
   *
   * If tenantId is provided, reaps for that tenant. Otherwise, iterates active tenants.
   */
  async reapOnce(limit = 100, tenantId?: string): Promise<HoldReaperResult> {
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
      const reaped = await withTenantTransaction(this.db, tid, async (trx: Kysely<Database>) => {
        // Use clock_timestamp() rather than transaction-start now() per Amendment B.4
        const expiredClaims = await trx
          .selectFrom("resource_claims")
          .where("tenant_id", "=", tid)
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
          await trx
            .updateTable("resource_claims")
            .set({
              state: "EXPIRED",
              blocking: false,
            })
            .where("tenant_id", "=", tid)
            .where("id", "=", claim.id)
            .execute();

          await trx
            .updateTable("bookings")
            .set((eb) => ({
              status: "EXPIRED",
              version: eb("version", "+", 1),
              hold_expires_at: null,
            }))
            .where("tenant_id", "=", tid)
            .where("id", "=", claim.booking_id)
            .where("status", "=", "HELD")
            .execute();

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

    if (totalReaped > 0) {
      this.logger.info({ count: totalReaped }, "Reaped expired booking holds");
    }
    return { reapedCount: totalReaped };
  }
}
