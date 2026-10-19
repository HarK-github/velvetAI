import { describe, it, expect } from "vitest";
import { OutboxWorker } from "../index.js";

describe("Outbox Worker", () => {
  it("starts and stops cleanly", async () => {
    const worker = new OutboxWorker();
    expect(worker.getStatus().isRunning).toBe(false);

    await worker.start();
    expect(worker.getStatus().isRunning).toBe(true);

    await worker.stop();
    expect(worker.getStatus().isRunning).toBe(false);
  });
});
