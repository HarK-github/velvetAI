import { AbuseScenario, deterministicScenarios } from "./scenarios.js";

export interface SuiteResult {
  total: number;
  passed: number;
  failed: number;
  criticalFailures: number;
  highFailures: number;
  results: Array<{
    id: string;
    name: string;
    severity: string;
    passed: boolean;
    message: string;
  }>;
}

export async function runAbuseSuite(
  scenarios: AbuseScenario[] = deterministicScenarios,
): Promise<SuiteResult> {
  const results = [];
  let passed = 0;
  let failed = 0;
  let criticalFailures = 0;
  let highFailures = 0;

  for (const scenario of scenarios) {
    try {
      const outcome = await scenario.run();
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
        severity: scenario.severity,
        passed: outcome.passed,
        message: outcome.message,
      });
    } catch (err: unknown) {
      failed += 1;
      if (scenario.severity === "CRITICAL") criticalFailures += 1;
      if (scenario.severity === "HIGH") highFailures += 1;
      const message = err instanceof Error ? err.message : "Scenario threw unexpected error";
      results.push({
        id: scenario.id,
        name: scenario.name,
        severity: scenario.severity,
        passed: false,
        message,
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
