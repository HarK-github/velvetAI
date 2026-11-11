import { AbuseScenario, deterministicScenarios } from "./scenarios.js";
import { transportScenarios } from "./transport-scenarios.js";

export const allAbuseScenarios: AbuseScenario[] = [
  ...deterministicScenarios,
  ...transportScenarios,
];

export interface ScenarioRunResult {
  id: string;
  name: string;
  category: AbuseScenario["category"];
  severity: AbuseScenario["severity"];
  threat: string;
  protects: string;
  passed: boolean;
  message: string;
  durationMs: number;
}

export interface SuiteResult {
  total: number;
  passed: number;
  failed: number;
  criticalFailures: number;
  highFailures: number;
  results: ScenarioRunResult[];
}

export async function runAbuseSuite(
  scenarios: AbuseScenario[] = deterministicScenarios,
): Promise<SuiteResult> {
  const results: ScenarioRunResult[] = [];
  let passed = 0;
  let failed = 0;
  let criticalFailures = 0;
  let highFailures = 0;

  for (const scenario of scenarios) {
    const start = performance.now();
    try {
      const outcome = await scenario.run();
      const durationMs = Math.max(0, Math.round(performance.now() - start));
      if (outcome.passed) {
        passed += 1;
      } else {
        failed += 1;
        if (scenario.severity === "CRITICAL") criticalFailures += 1;
        if (scenario.severity === "HIGH") highFailures += 1;
      }
      results.push({
        id: scenario.id,
        name: scenario.name,
        category: scenario.category,
        severity: scenario.severity,
        threat: scenario.threat,
        protects: scenario.protects,
        passed: outcome.passed,
        message: outcome.message,
        durationMs,
      });
    } catch (err: unknown) {
      const durationMs = Math.max(0, Math.round(performance.now() - start));
      failed += 1;
      if (scenario.severity === "CRITICAL") criticalFailures += 1;
      if (scenario.severity === "HIGH") highFailures += 1;
      const message = err instanceof Error ? err.message : "Scenario threw unexpected error";
      results.push({
        id: scenario.id,
        name: scenario.name,
        category: scenario.category,
        severity: scenario.severity,
        threat: scenario.threat,
        protects: scenario.protects,
        passed: false,
        message,
        durationMs,
      });
    }
  }

  return {
    total: scenarios.length,
    passed,
    failed,
    criticalFailures,
    highFailures,
    results,
  };
}
