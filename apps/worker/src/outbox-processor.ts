import { UUID, OutboxEventDTO, Rfc3339Timestamp } from "@velvetai/contracts";

export interface OutboxStore {
  claimEvents(batchSize: number, claimTtlSeconds: number): Promise<OutboxEventDTO[]>;
  markProcessed(eventId: UUID): Promise<void>;
  recordFailure(eventId: UUID, error: string, maxAttempts: number): Promise<void>;
  isEventProcessedByConsumer(consumerName: string, eventId: UUID): Promise<boolean>;
  recordInboxProcessed(consumerName: string, eventId: UUID): Promise<void>;
}

export interface EventHandler {
  handle(event: OutboxEventDTO): Promise<void>;
}

export class InMemoryOutboxStore implements OutboxStore {
  private events: OutboxEventDTO[] = [];
  private inbox = new Set<string>();

  addEvent(event: OutboxEventDTO): void {
    this.events.push({ ...event });
  }

  getEvents(): OutboxEventDTO[] {
    return this.events;
  }

  async claimEvents(batchSize: number, claimTtlSeconds: number): Promise<OutboxEventDTO[]> {
    const now = Date.now();
    const claimed: OutboxEventDTO[] = [];

    for (const evt of this.events) {
      if (claimed.length >= batchSize) break;
      if (evt.processedAt) continue;

      const isClaimed = evt.claimedAt !== null && evt.claimedAt !== undefined;
      const claimExpired = isClaimed && (now - new Date(evt.claimedAt!).getTime()) > claimTtlSeconds * 1000;

      if (!isClaimed || claimExpired) {
        evt.claimedAt = new Date(now).toISOString() as unknown as Rfc3339Timestamp;
        claimed.push(evt);
      }
    }
    return claimed;
  }

  async markProcessed(eventId: UUID): Promise<void> {
    const evt = this.events.find((e) => e.id === eventId);
    if (evt) {
      evt.processedAt = new Date().toISOString() as unknown as Rfc3339Timestamp;
      evt.claimedAt = null;
    }
  }

  async recordFailure(eventId: UUID, error: string, maxAttempts: number): Promise<void> {
    const evt = this.events.find((e) => e.id === eventId);
    if (evt) {
      evt.attempts = (evt.attempts || 0) + 1;
      evt.lastError = error;
      evt.claimedAt = null;
      if (evt.attempts >= maxAttempts) {
        evt.lastError = `DEAD_LETTER: ${error}`;
      }
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
  ) {}

  async processNextBatch(batchSize: number = 10, handler?: EventHandler): Promise<{ processed: number; failed: number }> {
    const claimedEvents = await this.store.claimEvents(batchSize, this.claimTtlSeconds);
    let processed = 0;
    let failed = 0;

    for (const event of claimedEvents) {
      try {
        const alreadyProcessed = await this.store.isEventProcessedByConsumer(this.consumerName, event.id);
        if (alreadyProcessed) {
          await this.store.markProcessed(event.id);
          processed += 1;
          continue;
        }

        if (handler) {
          await handler.handle(event);
        }

        await this.store.recordInboxProcessed(this.consumerName, event.id);
        await this.store.markProcessed(event.id);
        processed += 1;
      } catch (err: unknown) {
        failed += 1;
        const message = err instanceof Error ? err.message : "Unknown error";
        await this.store.recordFailure(event.id, message, this.maxAttempts);
      }
    }

    return { processed, failed };
  }
}
