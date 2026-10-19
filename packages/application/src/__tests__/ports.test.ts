import { describe, it, expect } from "vitest";
import { ClockPort } from "../index.js";

describe("Application Ports", () => {
  it("allows implementing ClockPort", () => {
    const fixedDate = new Date("2026-10-19T12:00:00Z");
    const testClock: ClockPort = {
      now: () => fixedDate,
    };

    expect(testClock.now().toISOString()).toBe("2026-10-19T12:00:00.000Z");
  });
});
