import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abuseLabReportSchema } from "@velvetai/contracts";
import {
  allAbuseScenarios,
  deterministicScenarios,
  transportScenarios,
  type AbuseScenario,
} from "../index.js";
import { generateAbuseLabReport } from "../report.js";

describe("WP 07 Part A: Abuse Lab CI Report Generator", () => {
  const sampleSha = "a1b2c3d4e5f6789012345678901234567890abcd";

  it("1. Every scenario defines plain-English threat and protects metadata", () => {
    expect(deterministicScenarios).toHaveLength(28);
    expect(transportScenarios).toHaveLength(23);
    expect(allAbuseScenarios).toHaveLength(51);

    for (const scenario of allAbuseScenarios) {
      expect(scenario.threat.trim().length).toBeGreaterThan(10);
      expect(scenario.protects.trim().length).toBeGreaterThan(10);
    }
  });

  it("2. Refuses to publish report when git working tree is dirty", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvet-abuse-dirty-"));
    const outPath = path.join(tmpDir, "abuse-lab-report.json");

    try {
      await expect(
        generateAbuseLabReport({
          outputPath: outPath,
          getGitStatus: () => " M apps/abuse-lab/src/scenarios.ts\n",
          getCommitSha: () => sampleSha,
        }),
      ).rejects.toThrow(/working tree has uncommitted changes/);

      expect(fs.existsSync(outPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("3. Refuses to publish report when any scenario fails or throws", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvet-abuse-fail-"));
    const outPathFail = path.join(tmpDir, "fail-report.json");
    const outPathThrow = path.join(tmpDir, "throw-report.json");

    const failingScenarios: AbuseScenario[] = [
      ...allAbuseScenarios.slice(0, 2),
      {
        id: "FAIL-001",
        name: "Simulated failing control",
        severity: "CRITICAL",
        category: "AUTH",
        description: "Intentionally fails for test",
        threat: "Simulated breach",
        protects: "Guard check",
        run: async () => ({ passed: false, message: "control bypassed" }),
      },
    ];

    const throwingScenarios: AbuseScenario[] = [
      ...allAbuseScenarios.slice(0, 2),
      {
        id: "ERR-001",
        name: "Simulated crashing scenario",
        severity: "HIGH",
        category: "CRYPTO",
        description: "Throws error",
        threat: "Crash",
        protects: "Exception boundary",
        run: async () => {
          throw new Error("unexpected panic");
        },
      },
    ];

    try {
      await expect(
        generateAbuseLabReport({
          outputPath: outPathFail,
          scenarios: failingScenarios,
          getGitStatus: () => "",
          getCommitSha: () => sampleSha,
        }),
      ).rejects.toThrow(/1 of 3 scenarios failed/);
      expect(fs.existsSync(outPathFail)).toBe(false);

      await expect(
        generateAbuseLabReport({
          outputPath: outPathThrow,
          scenarios: throwingScenarios,
          getGitStatus: () => "",
          getCommitSha: () => sampleSha,
        }),
      ).rejects.toThrow(/1 of 3 scenarios failed/);
      expect(fs.existsSync(outPathThrow)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("4. Generates valid schema-checked CI JSON report for all 51 scenarios on clean tree", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvet-abuse-pass-"));
    const outPath = path.join(tmpDir, "abuse-lab-report.json");
    const fixedDate = new Date("2026-11-10T18:00:00.000Z");

    try {
      const { report } = await generateAbuseLabReport({
        outputPath: outPath,
        getGitStatus: () => "",
        getCommitSha: () => sampleSha,
        now: () => fixedDate,
      });

      expect(fs.existsSync(outPath)).toBe(true);
      const diskJson = JSON.parse(fs.readFileSync(outPath, "utf8"));
      const parsed = abuseLabReportSchema.parse(diskJson);

      expect(parsed).toEqual(report);
      expect(parsed.generatedAt).toBe("2026-11-10T18:00:00.000Z");
      expect(parsed.commitSha).toBe(sampleSha);
      expect(parsed.total).toBe(51);
      expect(parsed.passed).toBe(51);
      expect(parsed.scenarios).toHaveLength(51);
      expect(parsed.scenarios.every((s) => s.result === "PASS")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
