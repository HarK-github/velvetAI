import { describe, it, expect } from "vitest";

export interface ScenarioResult {
  id: string;
  name: string;
  severity: "Critical" | "High" | "Medium";
  passed: boolean;
  evidence: string;
}

export class AbuseLabRunner {
  private scenarios: Array<() => Promise<ScenarioResult>> = [];

  register(scenario: () => Promise<ScenarioResult>): void {
    this.scenarios.push(scenario);
  }

  async runAll(): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];
    for (const scenario of this.scenarios) {
      results.push(await scenario());
    }
    return results;
  }
}

describe("Agent Abuse Lab Scenarios", () => {
  it("executes registered security scenarios and reports determinism", async () => {
    const lab = new AbuseLabRunner();
    lab.register(async () => ({
      id: "AL-001",
      name: "Hidden prompt instruction injection",
      severity: "Critical",
      passed: true,
      evidence: "Privileged tool execution blocked by deterministic gateway",
    }));

    const results = await lab.runAll();
    expect(results.length).toBe(1);
    expect(results[0]?.passed).toBe(true);
    expect(results[0]?.severity).toBe("Critical");
  });
});
