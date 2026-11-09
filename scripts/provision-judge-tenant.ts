import { createDatabaseClient, type Database, type Kysely } from "../packages/db/src/index.ts";
import { JudgeResetService } from "../packages/application/src/judge/judge-reset-service.ts";
import { JUDGE_TENANT_ID } from "../packages/domain/src/judge.ts";
import { loadRootEnv, extractDatabaseName } from "./load-env.js";

export async function provisionJudgeTenant(): Promise<void> {
  loadRootEnv();

  if (process.env.ALLOW_JUDGE_PROVISION !== "1") {
    console.error(
      "\n[ERROR] Judge tenant provisioning aborted: ALLOW_JUDGE_PROVISION=1 must be set in environment.",
    );
    console.error("Usage: ALLOW_JUDGE_PROVISION=1 pnpm judge:provision\n");
    process.exit(1);
  }

  const databaseUrl =
    process.env.DATABASE_MIGRATION_URL ||
    process.env.DATABASE_URL ||
    "postgresql://localhost:5432/velvetai?sslmode=disable";

  const dbName = extractDatabaseName(databaseUrl);
  console.log(`\n======================================================`);
  console.log(`[JUDGE PROVISION] Target database: ${dbName}`);
  console.log(`[JUDGE PROVISION] Tenant ID:       ${JUDGE_TENANT_ID}`);
  console.log(`======================================================\n`);

  const db: Kysely<Database> = createDatabaseClient(databaseUrl);
  const resetService = new JudgeResetService(db);

  try {
    const startTime = Date.now();
    const systemUserId = "01932b10-0000-7000-8000-000000000002";

    const result = await resetService.resetJudgeTenant({
      tenantId: JUDGE_TENANT_ID,
      requestedBy: systemUserId,
    });

    const elapsed = Date.now() - startTime;
    console.log(`[SUCCESS] Judge tenant provisioned successfully in ${elapsed} ms.`);
    console.log(`[RUN ID] ${result.runId}`);
    console.log(`\nSummary:`);
    console.log(JSON.stringify(result.summary, null, 2));
    console.log(`\nSteps executed:`);
    for (const step of result.steps) {
      console.log(
        ` - ${step.name.padEnd(28)}: [${step.status}] ${step.count !== undefined ? `count=${step.count} ` : ""}(${step.ms} ms)`,
      );
    }
  } catch (err: unknown) {
    console.error("\n[ERROR] Provisioning failed:", err);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Auto-run when invoked directly
if (process.argv[1]?.endsWith("provision-judge-tenant.ts")) {
  provisionJudgeTenant().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
