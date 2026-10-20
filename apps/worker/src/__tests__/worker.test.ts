import { describe, it, expect } from "vitest";
import { generateUUIDv7, tenantIdSchema, UUID, Rfc3339Timestamp } from "@velvetai/contracts";
import { OutboxWorker, OutboxProcessor, InMemoryOutboxStore } from "../index.js";

describe("OutboxWorker & OutboxProcessor", () => {
  it("initializes and reports correct worker running status", async () => {
    const worker = new OutboxWorker();
    expect(worker.getStatus().isRunning).toBe(false);

    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);

    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });

  it("claims and processes outbox events", async () => {
    const store = new InMemoryOutboxStore();
    const eventId = generateUUIDv7();
    const tenantId = tenantIdSchema.parse(generateUUIDv7());

    store.addEvent({
      id: eventId as unknown as UUID,
      tenantId,
      aggregateType: "BOOKING",
      aggregateId: generateUUIDv7(),
      eventType: "BOOKING_CONFIRMED",
      payload: { bookingId: "b-1" },
      createdAt: new Date().toISOString() as unknown as Rfc3339Timestamp,
      attempts: 0,
    });

    const processedEvents: string[] = [];
    const processor = new OutboxProcessor(store, "test-consumer", 3, 30);

    const result = await processor.processNextBatch(10, {
      handle: async (evt) => {
        processedEvents.push(evt.id);
      },
    });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(processedEvents).toContain(eventId);

    const allEvents = store.getEvents();
    expect(allEvents[0]?.processedAt).toBeDefined();
  });

  it("deduplicates already processed inbox events", async () => {
    const store = new InMemoryOutboxStore();
    const eventId = generateUUIDv7();
    const tenantId = tenantIdSchema.parse(generateUUIDv7());

    store.addEvent({
      id: eventId as unknown as UUID,
      tenantId,
      aggregateType: "BOOKING",
      aggregateId: generateUUIDv7(),
      eventType: "BOOKING_CONFIRMED",
      payload: {},
      createdAt: new Date().toISOString() as unknown as Rfc3339Timestamp,
      attempts: 0,
    });

    let executionCount = 0;
    const processor = new OutboxProcessor(store, "duplicate-consumer", 3, 30);

    await processor.processNextBatch(10, {
      handle: async () => {
        executionCount += 1;
      },
    });
    expect(executionCount).toBe(1);

    store.getEvents()[0]!.processedAt = undefined;
    store.getEvents()[0]!.claimedAt = undefined;

    await processor.processNextBatch(10, {
      handle: async () => {
        executionCount += 1;
      },
    });
    expect(executionCount).toBe(1);
  });

  it("records attempts and transitions to dead-letter state after max failures", async () => {
    const store = new InMemoryOutboxStore();
    const eventId = generateUUIDv7();
    const tenantId = tenantIdSchema.parse(generateUUIDv7());

    store.addEvent({
      id: eventId as unknown as UUID,
      tenantId,
      aggregateType: "PAYMENT",
      aggregateId: generateUUIDv7(),
      eventType: "CAPTURE_FAILED",
      payload: {},
      createdAt: new Date().toISOString() as unknown as Rfc3339Timestamp,
      attempts: 0,
    });

    const processor = new OutboxProcessor(store, "faulty-consumer", 2, 30);

    const r1 = await processor.processNextBatch(10, {
      handle: async () => {
        throw new Error("Network timeout");
      },
    });
    expect(r1.failed).toBe(1);
    expect(store.getEvents()[0]?.attempts).toBe(1);
    expect(store.getEvents()[0]?.lastError).toBe("Network timeout");

    const r2 = await processor.processNextBatch(10, {
      handle: async () => {
        throw new Error("Permanent rejection");
      },
    });
    expect(r2.failed).toBe(1);
    expect(store.getEvents()[0]?.attempts).toBe(2);
    expect(store.getEvents()[0]?.lastError).toContain("DEAD_LETTER");
  });

  it("recovers and processes unprocessed events after worker interruption", async () => {
    const store = new InMemoryOutboxStore();
    const eventId = generateUUIDv7();
    const tenantId = tenantIdSchema.parse(generateUUIDv7());

    const expiredClaimTime = new Date(Date.now() - 60_000).toISOString() as unknown as Rfc3339Timestamp;
    store.addEvent({
      id: eventId as unknown as UUID,
      tenantId,
      aggregateType: "BOOKING",
      aggregateId: generateUUIDv7(),
      eventType: "HOLD_CREATED",
      payload: { bookingId: "b-2" },
      createdAt: new Date(Date.now() - 70_000).toISOString() as unknown as Rfc3339Timestamp,
      claimedAt: expiredClaimTime,
      attempts: 0,
    });

    const newWorker = new OutboxWorker(store);
    const result = await newWorker.processor.processNextBatch(10);

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(store.getEvents()[0]?.processedAt).toBeDefined();
  });
});
