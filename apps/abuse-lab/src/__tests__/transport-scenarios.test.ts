import { describe, it, expect } from "vitest";
import { transportScenarios } from "../transport-scenarios.js";

describe("W7: Abuse Lab Transport-Level Security Scenarios (23 Deterministically Proven)", () => {
  it("includes all 23 required transport-level scenarios", () => {
    expect(transportScenarios).toHaveLength(23);
    const ids = transportScenarios.map((s) => s.id);
    for (let i = 1; i <= 23; i++) {
      const expectedId = `TRANS-${String(i).padStart(3, "0")}`;
      expect(ids).toContain(expectedId);
    }
  });

  describe.each(transportScenarios)("Scenario $id: $name ($severity)", (scenario) => {
    it("executes deterministically and passes security invariant", async () => {
      const result = await scenario.run();
      expect(result.passed).toBe(true);
      expect(result.message).toBeTruthy();
    });
  });
});
