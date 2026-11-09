import "./env-loader.js";
import { buildApp } from "./app.js";
import { validateEnv } from "@velvetai/observability";
import { OutboxWorker } from "@velvetai/worker";

async function main() {
  const env = validateEnv();
  const app = buildApp();

  const migrationUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (migrationUrl && process.env.AUTO_MIGRATE !== "false") {
    try {
      const { createDatabaseClient, migrateToLatest } = await import("@velvetai/db");
      const migratorDb = createDatabaseClient(migrationUrl);
      await migrateToLatest(migratorDb);
      await migratorDb.destroy();
      app.log.info("[database] Startup migrations executed successfully");
    } catch (migErr) {
      app.log.warn({ err: migErr }, "[database] Automatic startup migration failed or skipped");
    }
  }

  let worker: OutboxWorker | null = null;
  if (process.env.EMBED_WORKER !== "false") {
    try {
      worker = new OutboxWorker();
      await worker.start();
      app.log.info(
        "[embedded-worker] Outbox processor, hold reaper, and reconciliation active in API process",
      );
    } catch (workerErr) {
      app.log.warn({ err: workerErr }, "[embedded-worker] Failed to start embedded worker");
    }
  }

  app.addHook("onClose", async () => {
    if (worker) {
      await worker.stop();
    }
  });

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`velvetAI API running at http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}
