import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abuseLabReportSchema, type AbuseLabReport } from "@velvetai/contracts";
import type { AbuseScenario } from "./scenarios.js";
import { allAbuseScenarios, runAbuseSuite } from "./runner.js";

export interface GenerateAbuseLabReportOptions {
  repoRoot?: string;
  outputPath?: string;
  scenarios?: AbuseScenario[];
  allowDirty?: boolean;
  getGitStatus?: (repoRoot: string) => string;
  getCommitSha?: (repoRoot: string) => string;
  now?: () => Date;
}

function defaultRepoRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  // apps/abuse-lab/src or apps/abuse-lab/dist -> repository root is three levels up
  return path.resolve(currentDir, "../../..");
}

function defaultGetGitStatus(repoRoot: string): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function defaultGetCommitSha(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

export async function generateAbuseLabReport(
  options: GenerateAbuseLabReportOptions = {},
): Promise<{ report: AbuseLabReport; outputPath: string }> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const outputPath =
    options.outputPath ?? path.resolve(repoRoot, "apps/web/src/data/abuse-lab-report.json");
  const getGitStatus = options.getGitStatus ?? defaultGetGitStatus;
  const getCommitSha = options.getCommitSha ?? defaultGetCommitSha;
  const scenarios = options.scenarios ?? allAbuseScenarios;

  // 1. Refuse if working tree is dirty
  if (!options.allowDirty) {
    const status = getGitStatus(repoRoot).trim();
    if (status.length > 0) {
      throw new Error(
        `Refusing to write CI Abuse Lab report: working tree has uncommitted changes.\n${status}`,
      );
    }
  }

  // 2. Resolve current commit SHA
  const commitSha = getCommitSha(repoRoot).trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(`Invalid commit SHA returned by git rev-parse HEAD: "${commitSha}"`);
  }

  // 3. Execute full scenario suite; refuse if any scenario fails
  const suiteResult = await runAbuseSuite(scenarios);
  if (suiteResult.failed > 0 || suiteResult.passed !== suiteResult.total) {
    const failing = suiteResult.results
      .filter((r) => !r.passed)
      .map((r) => `${r.id}: ${r.message}`)
      .join("; ");
    throw new Error(
      `Refusing to write CI Abuse Lab report: ${suiteResult.failed} of ${suiteResult.total} scenarios failed (${failing})`,
    );
  }

  // 4. Construct and validate JSON payload against canonical contract schema
  const rawReport = {
    generatedAt: (options.now ? options.now() : new Date()).toISOString(),
    commitSha,
    total: suiteResult.total,
    passed: suiteResult.passed,
    scenarios: suiteResult.results.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      severity: r.severity,
      threat: r.threat,
      protects: r.protects,
      result: r.passed ? ("PASS" as const) : ("FAIL" as const),
      durationMs: r.durationMs,
    })),
  };

  const validatedReport = abuseLabReportSchema.parse(rawReport);

  // 5. Write formatted JSON to outputPath
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(validatedReport, null, 2)}\n`, "utf8");

  return { report: validatedReport, outputPath };
}

const entryArg = process.argv[1];
if (entryArg && (entryArg.endsWith("report.ts") || entryArg.endsWith("report.js"))) {
  generateAbuseLabReport()
    .then(({ report, outputPath }) => {
      console.log(
        `[ABUSE-LAB REPORT] Verified ${report.passed}/${report.total} scenarios at commit ${report.commitSha.slice(0, 7)}. Wrote ${outputPath}`,
      );
    })
    .catch((err: unknown) => {
      console.error("[ABUSE-LAB REPORT ERROR]", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
