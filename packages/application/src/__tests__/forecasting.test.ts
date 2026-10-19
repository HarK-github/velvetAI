import { describe, it, expect } from "vitest";
import { calculateBrierScore, calculateWAPE } from "../forecasting.js";

describe("Forecasting Metrics", () => {
  it("calculates Brier Score accurately", () => {
    // Perfect predictions
    expect(calculateBrierScore([1, 0, 1], [1, 0, 1])).toBe(0);

    // Worst predictions
    expect(calculateBrierScore([0, 1], [1, 0])).toBe(1);

    // Moderate predictions
    // (0.8 - 1)^2 = 0.04; (0.2 - 0)^2 = 0.04 -> mean 0.04
    expect(calculateBrierScore([0.8, 0.2], [1, 0])).toBeCloseTo(0.04);
  });

  it("calculates WAPE accurately", () => {
    // Total actual = 100 + 200 = 300
    // Errors = |90 - 100| + |210 - 200| = 10 + 10 = 20
    // WAPE = 20 / 300 = 0.0667
    expect(calculateWAPE([90, 210], [100, 200])).toBeCloseTo(0.0667, 3);
  });

  it("handles empty arrays or mismatched lengths defensively", () => {
    expect(() => calculateBrierScore([], [])).toThrow();
    expect(() => calculateBrierScore([0.5], [1, 0])).toThrow();
    expect(() => calculateWAPE([], [])).toThrow();
    expect(() => calculateWAPE([10], [10, 20])).toThrow();
  });
});
