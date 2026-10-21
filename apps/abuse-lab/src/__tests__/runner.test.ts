import { describe, it, test, expect } from "vitest";
import { runAbuseSuite, deterministicScenarios } from "../index.js";

describe("Abuse Lab Runner", () => {
  it("executes full deterministic attack suite of 28 scenarios with 0 failures", async () => {
    const result = await runAbuseSuite();
    expect(result.total).toBe(28);
    expect(result.passed).toBe(28);
    expect(result.failed).toBe(0);
    expect(result.criticalFailures).toBe(0);
    expect(result.highFailures).toBe(0);
  });

  describe("Specification v1.1 Amendment Section I Scenarios (28 deterministically proven)", () => {
    test.each(deterministicScenarios)("$id: $name ($severity)", async (scenario) => {
      const outcome = await scenario.run();
      expect(outcome.passed).toBe(true);
      expect(outcome.message).toBeTruthy();
    });
  });
});
