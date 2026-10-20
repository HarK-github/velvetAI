import { describe, it, expect } from "vitest";
import { runAbuseSuite } from "../index.js";

describe("Abuse Lab Runner", () => {
  it("executes deterministic attack scenarios and enforces 0 critical or high failures", async () => {
    const result = await runAbuseSuite();
    expect(result.total).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(result.criticalFailures).toBe(0);
    expect(result.highFailures).toBe(0);
  });
});
