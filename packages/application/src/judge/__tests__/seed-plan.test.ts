import { describe, it, expect } from "vitest";
import { buildJudgeSeedPlan } from "../seed-plan.js";
import { JUDGE_SEED_VERSION } from "@velvetai/domain";

describe("Judge Seed Plan Generator (Pure & Deterministic)", () => {
  const baseNow = new Date("2026-11-09T14:30:00.000Z"); // Monday Nov 9, 2026
  const timeZone = "America/New_York";

  it("1. Determinism: identical inputs produce deeply equal plans", () => {
    const plan1 = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });
    const plan2 = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });

    expect(plan1).toEqual(plan2);
    expect(plan1.fixtures.length).toBeGreaterThan(10);
    expect(plan1.history.length).toBeGreaterThan(50);
  });

  it("2. No overlapping fixtures per resource", () => {
    const plan = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });

    // Group fixtures by resource
    const resourceFixtures = new Map<string, typeof plan.fixtures>();
    for (const f of plan.fixtures) {
      if (!resourceFixtures.has(f.resourceId)) {
        resourceFixtures.set(f.resourceId, []);
      }
      resourceFixtures.get(f.resourceId)!.push(f);
    }

    for (const [resId, fixtures] of resourceFixtures.entries()) {
      // Sort by startsAt
      fixtures.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

      for (let i = 0; i < fixtures.length - 1; i++) {
        const curr = fixtures[i]!;
        const next = fixtures[i + 1]!;

        expect(
          curr.endsAt.getTime() <= next.startsAt.getTime(),
          `Overlap detected on resource ${resId}: ${curr.startsAt.toISOString()} to ${curr.endsAt.toISOString()} overlaps with ${next.startsAt.toISOString()} to ${next.endsAt.toISOString()}`,
        ).toBe(true);
      }
    }
  });

  it("3. All fixture times inside merchant opening hours (09:00 - 19:00 America/New_York)", () => {
    const plan = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });

    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });

    for (const f of plan.fixtures) {
      const startParts = dtf.formatToParts(f.startsAt);
      const endParts = dtf.formatToParts(f.endsAt);

      const startHour = parseInt(startParts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const endHour = parseInt(endParts.find((p) => p.type === "hour")?.value ?? "0", 10);
      const endMinute = parseInt(endParts.find((p) => p.type === "minute")?.value ?? "0", 10);

      expect(startHour).toBeGreaterThanOrEqual(9);
      expect(endHour * 60 + endMinute).toBeLessThanOrEqual(19 * 60);
    }
  });

  it("4. DST transition date input remains valid and produces consistent slots", () => {
    // US Daylight Saving Time ends on first Sunday in November (Nov 1, 2026)
    const dstDate = new Date("2026-11-01T12:00:00.000Z");
    const plan = buildJudgeSeedPlan({ now: dstDate, timeZone, seed: JUDGE_SEED_VERSION });

    expect(plan.fixtures.length).toBeGreaterThan(0);
    for (const f of plan.fixtures) {
      expect(f.startsAt.getTime()).toBeLessThan(f.endsAt.getTime());
    }
  });

  it("5. Monday morning has clear weak windows (free slots 09:00 - 12:00)", () => {
    const plan = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });

    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      hour12: false,
    });

    const mondayMorningFixtures = plan.fixtures.filter((f) => {
      const parts = dtf.formatToParts(f.startsAt);
      const weekday = parts.find((p) => p.type === "weekday")?.value;
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
      return weekday === "Mon" && hour >= 9 && hour < 12;
    });

    // Zero fixtures scheduled on Monday mornings by deliberate design
    expect(mondayMorningFixtures.length).toBe(0);
  });

  it("6. All required display statuses are represented across fixtures", () => {
    const plan = buildJudgeSeedPlan({ now: baseNow, timeZone, seed: JUDGE_SEED_VERSION });
    const statuses = new Set(plan.fixtures.map((f) => f.displayStatus));

    expect(statuses.has("CONFIRMED")).toBe(true);
    expect(statuses.has("CHECKED_IN")).toBe(true);
    expect(statuses.has("COMPLETED")).toBe(true);
    expect(statuses.has("NO_SHOW")).toBe(true);
    expect(statuses.has("CANCELLED")).toBe(true);
  });
});

