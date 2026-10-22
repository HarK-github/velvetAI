import crypto from "node:crypto";
import { Kysely } from "kysely";
import { Database, withTenantTransaction } from "@velvetai/db";
import { UUID, TenantId, Rfc3339Timestamp, OutboxEventDTO } from "@velvetai/contracts";
import { OutboxStore, ClaimedOutboxEvent } from "./outbox-processor.js";

export class PostgreSqlOutboxStore implements OutboxStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly maxAttempts: number = 5,
    private readonly baseBackoffMs: number = 1000,
    private readonly maxBackoffMs: number = 60000,
  ) {}

  /**
   * Claims batch of outbox events using FOR UPDATE SKIP LOCKED with a fenced lease token.
   * Commits the claim immediately before the worker proceeds to process side effects.
   */
  async claimEvents(
    batchSize: number,
    claimTtlSeconds: number,
    tenantId?: TenantId,
  ): Promise<ClaimedOutboxEvent[]> {
    const leaseToken = crypto.randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + claimTtlSeconds * 1000);

    const tenants = tenantId
      ? [{ id: tenantId }]
      : await this.db.selectFrom("tenants").select(["id"]).where("status", "=", "ACTIVE").execute();

    const claimedEvents: ClaimedOutboxEvent[] = [];

    for (const t of tenants) {
      if (claimedEvents.length >= batchSize) break;
      const remainingLimit = batchSize - claimedEvents.length;

      const tenantEvents = await withTenantTransaction(this.db, t.id, async (trx) => {
        const rows = await trx
          .selectFrom("outbox_events")
          .where("tenant_id", "=", t.id)
          .where("processed_at", "is", null)
          .where("attempts", "<", this.maxAttempts)
          .where((eb) =>
            eb.or([eb("lease_expires_at", "is", null), eb("lease_expires_at", "<=", now)]),
          )
          .selectAll()
          .orderBy("created_at", "asc")
          .limit(remainingLimit)
          .forUpdate()
          .skipLocked()
          .execute();

        if (rows.length === 0) return [];

        const ids = rows.map((r) => r.id);
        await trx
          .updateTable("outbox_events")
          .set({
            lease_token: leaseToken,
            lease_expires_at: leaseExpiresAt,
            claimed_at: now,
          })
          .where("tenant_id", "=", t.id)
          .where("id", "in", ids)
          .execute();

        return rows.map((r) => ({
          id: r.id as OutboxEventDTO["id"],
          tenantId: r.tenant_id as TenantId,
          aggregateType: r.aggregate_type,
          aggregateId: r.aggregate_id as UUID,
          eventType: r.event_type,
          payload: r.payload as Record<string, unknown>,
          createdAt: r.created_at.toISOString() as unknown as Rfc3339Timestamp,
          claimedAt: now.toISOString() as unknown as Rfc3339Timestamp,
          processedAt: null,
          attempts: r.attempts,
          lastError: r.last_error,
          leaseToken,
        }));
      });

      claimedEvents.push(...tenantEvents);
    }

    return claimedEvents;
  }

  /**
   * Acknowledges an event as processed.
   * Returns false if the leaseToken does not match (proving the lease was reclaimed by another worker).
   */
  async markProcessed(eventId: UUID, leaseToken?: string): Promise<boolean> {
    const now = new Date();

    const evt = await this.db
      .selectFrom("outbox_events")
      .select(["id", "tenant_id", "lease_token"])
      .where("id", "=", eventId)
      .executeTakeFirst();

    if (!evt) return false;

    // Fencing check: reject stale worker if leaseToken does not match
    if (leaseToken && evt.lease_token && evt.lease_token !== leaseToken) {
      return false;
    }

    const updated = await withTenantTransaction(this.db, evt.tenant_id, async (trx) => {
      let query = trx
        .updateTable("outbox_events")
        .set({
          processed_at: now,
          lease_token: null,
          lease_expires_at: null,
        })
        .where("tenant_id", "=", evt.tenant_id)
        .where("id", "=", eventId);

      if (leaseToken) {
        query = query.where("lease_token", "=", leaseToken);
      }

      const res = await query.executeTakeFirst();
      return Number(res.numUpdatedRows) > 0;
    });

    return updated;
  }

  /**
   * Records failure with bounded exponential backoff and jitter.
   * Dead-letters the event when attempts reach maxAttempts.
   */
  async recordFailure(
    eventId: UUID,
    error: string,
    maxAttempts: number,
    leaseToken?: string,
  ): Promise<void> {
    const evt = await this.db
      .selectFrom("outbox_events")
      .select(["id", "tenant_id", "attempts", "lease_token"])
      .where("id", "=", eventId)
      .executeTakeFirst();

    if (!evt) return;

    // Ignore failure report from stale worker whose lease was already lost
    if (leaseToken && evt.lease_token && evt.lease_token !== leaseToken) {
      return;
    }

    const newAttempts = (evt.attempts || 0) + 1;
    const isDeadLetter = newAttempts >= maxAttempts;
    const lastError = isDeadLetter ? `DEAD_LETTER: ${error}` : error;

    const backoffMs = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * Math.pow(2, newAttempts - 1),
    );
    const jitter = Math.floor(Math.random() * (backoffMs * 0.2));
    const delay = backoffMs + jitter;
    const nextLeaseExpires = isDeadLetter ? null : new Date(Date.now() + delay);

    await withTenantTransaction(this.db, evt.tenant_id, async (trx) => {
      let query = trx
        .updateTable("outbox_events")
        .set({
          attempts: newAttempts,
          last_error: lastError,
          lease_token: null,
          lease_expires_at: nextLeaseExpires,
        })
        .where("tenant_id", "=", evt.tenant_id)
        .where("id", "=", eventId);

      if (leaseToken) {
        query = query.where("lease_token", "=", leaseToken);
      }

      await query.execute();
    });
  }

  async isEventProcessedByConsumer(consumerName: string, eventId: UUID): Promise<boolean> {
    const row = await this.db
      .selectFrom("inbox_events")
      .select(["id"])
      .where("consumer_name", "=", consumerName)
      .where("event_id", "=", eventId)
      .executeTakeFirst();

    return !!row;
  }

  async recordInboxProcessed(consumerName: string, eventId: UUID): Promise<void> {
    await this.db
      .insertInto("inbox_events")
      .values({
        id: crypto.randomUUID(),
        consumer_name: consumerName,
        event_id: eventId,
      })
      .onConflict((oc) => oc.columns(["consumer_name", "event_id"]).doNothing())
      .execute();
  }
}
