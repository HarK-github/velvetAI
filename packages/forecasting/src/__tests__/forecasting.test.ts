import { describe, it, expect } from "vitest";
import {
  calculateBrierScore,
  calculateWAPE,
  predictNoShowProbability,
  predictSlotFillProbability,
} from "../index.js";

describe("Forecasting Metrics & Models", () => {
  it("calculates Brier score correctly", () => {
    // Perfect predictions
    expect(calculateBrierScore([1, 0, 1], [1, 0, 1])).toBe(0);
    // Worst predictions
    expect(calculateBrierScore([1, 0], [0, 1])).toBe(1);
    // Partial accuracy
    expect(calculateBrierScore([0.8, 0.2], [1, 0])).toBeCloseTo(0.04);
  });

  it("calculates WAPE correctly", () => {
    // Actual: 100, Forecast: 90 -> Error: 10 / 100 = 0.10
    expect(calculateWAPE([90], [100])).toBe(0.1);
  });

  it("produces bounded no-show probability and risk bands", () => {
    const lowRisk = predictNoShowProbability({
      leadTimeHours: 12,
      weekday: 2,
      depositTier: "FULL",
      rescheduleCount: 0,
    });
    expect(lowRisk.probability).toBeLessThan(0.1);
    expect(lowRisk.riskBand).toBe("low");

    const highRisk = predictNoShowProbability({
      leadTimeHours: 300,
      weekday: 5,
      depositTier: "NONE",
      rescheduleCount: 3,
    });
    expect(highRisk.probability).toBeGreaterThan(0.25);
    expect(highRisk.riskBand).toBe("high");
  });

  it("produces slot-fill probability between 0 and 1", () => {
    const fill = predictSlotFillProbability({
      leadTimeHours: 24,
      weekday: 6,
      hourOfDay: 14,
    });
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(fill).toBeLessThanOrEqual(1);
  });
});
