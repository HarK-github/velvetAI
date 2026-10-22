import { UUID, OutboxEventDTO, Rfc3339Timestamp, TenantId } from "@velvetai/contracts";

export interface ClaimedOutboxEvent extends OutboxEventDTO {
  leaseToken?: string;
}

export interface OutboxStore {
  claimEvents(
    batchSize: number,
    claimTtlSeconds: number,
    tenantId?: TenantId,
  ): Promise<ClaimedOutboxEvent[]>;
  markProcessed(eventId: UUID, leaseToken?: string): Promise<boolean>;
  recordFailure(
    eventId: UUID,
    error: string,
    maxAttempts: number,
    leaseToken?: string,
  ): Promise<void>;
  isEventProcessedByConsumer(consumerName: string, eventId: UUID): Promise<boolean>;
  recordInboxProcessed(consumerName: string, eventId: UUID): Promise<void>;
}

export interface EventHandler {
  handle(event: OutboxEventDTO): Promise<void>;
}

export class InMemoryOutboxStore implements OutboxStore {
  private events: ClaimedOutboxEvent[] = [];
  private inbox = new Set<string>();

  addEvent(event: OutboxEventDTO): void {
    this.events.push({ ...event });
  }

  getEvents(): ClaimedOutboxEvent[] {
    return this.events;
  }

  async claimEvents(
    batchSize: number,
    claimTtlSeconds: number,
    tenantId?: TenantId,
  ): Promise<ClaimedOutboxEvent[]> {
    const now = Date.now();
    const claimed: ClaimedOutboxEvent[] = [];

    for (const evt of this.events) {
      if (claimed.length >= batchSize) break;
      if (tenantId && evt.tenantId !== tenantId) continue;
      if (evt.processedAt) continue;

      const isClaimed = evt.claimedAt !== null && evt.claimedAt !== undefined;
      const claimExpired =
        isClaimed && now - new Date(evt.claimedAt!).getTime() > claimTtlSeconds * 1000;

      if (!isClaimed || claimExpired) {
        evt.claimedAt = new Date(now).toISOString() as unknown as Rfc3339Timestamp;
        evt.leaseToken = crypto.randomUUID();
        claimed.push({ ...evt });
      }
    }
    return claimed;
  }

  async markProcessed(eventId: UUID, leaseToken?: string): Promise<boolean> {
    const evt = this.events.find((e) => e.id === eventId);
    if (!evt) return false;

    // Fencing token check: reject stale worker if leaseToken does not match
    if (leaseToken && evt.leaseToken && evt.leaseToken !== leaseToken) {
      return false;
    }

    evt.processedAt = new Date().toISOString() as unknown as Rfc3339Timestamp;
    evt.claimedAt = null;
    evt.leaseToken = undefined;
    return true;
  }

  async recordFailure(
    eventId: UUID,
    error: string,
    maxAttempts: number,
    leaseToken?: string,
  ): Promise<void> {
    const evt = this.events.find((e) => e.id === eventId);
    if (!evt) return;

    if (leaseToken && evt.leaseToken && evt.leaseToken !== leaseToken) {
      return;
    }

    evt.attempts = (evt.attempts || 0) + 1;
    evt.lastError = error;
    evt.claimedAt = null;
    evt.leaseToken = undefined;
    if (evt.attempts >= maxAttempts) {
      evt.lastError = `DEAD_LETTER: ${error}`;
    }
  }

  async isEventProcessedByConsumer(consumerName: string, eventId: UUID): Promise<boolean> {
    return this.inbox.has(`${consumerName}:${eventId}`);
  }

  async recordInboxProcessed(consumerName: string, eventId: UUID): Promise<void> {
    this.inbox.add(`${consumerName}:${eventId}`);
  }
}

export class OutboxProcessor {
  constructor(
    private readonly store: OutboxStore,
    private readonly consumerName: string = "default-worker",
    private readonly maxAttempts: number = 3,
    private readonly claimTtlSeconds: number = 30,
    private readonly tenantId?: TenantId,
  ) {}

  async processNextBatch(
    batchSize: number = 10,
    handler?: EventHandler,
  ): Promise<{ processed: number; failed: number }> {
    const claimedEvents = await this.store.claimEvents(
      batchSize,
      this.claimTtlSeconds,
      this.tenantId,
    );
    let processed = 0;
    let failed = 0;

    for (const event of claimedEvents) {
      try {
        const alreadyProcessed = await this.store.isEventProcessedByConsumer(
          this.consumerName,
          event.id,
        );
        if (alreadyProcessed) {
          const acked = await this.store.markProcessed(event.id, event.leaseToken);
          if (acked) {
            processed += 1;
          } else {
            failed += 1;
          }
          continue;
        }

        if (handler) {
          await handler.handle(event);
        }

        await this.store.recordInboxProcessed(this.consumerName, event.id);
        const acked = await this.store.markProcessed(event.id, event.leaseToken);
        if (acked) {
          processed += 1;
        } else {
          // Stale worker: lease was reclaimed by another worker!
          failed += 1;
        }
      } catch (err: unknown) {
        failed += 1;
        const message = err instanceof Error ? err.message : "Unknown error";
        await this.store.recordFailure(event.id, message, this.maxAttempts, event.leaseToken);
      }
    }

    return { processed, failed };
  }
}
