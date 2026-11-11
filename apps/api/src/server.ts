import "./env-loader.js";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { buildApp } from "./app.js";
import { createDatabaseClient, migrateToLatestWithAdvisoryLock, type Database } from "@velvetai/db";
import { validateEnv, type Env } from "@velvetai/observability";
import type { PaymentPort } from "@velvetai/application";
import { OutboxWorker } from "@velvetai/worker";
import { paypalAdapter } from "./routes/payments.js";

export interface StartupRuntimeOptions {
  rawEnv?: Record<string, unknown>;
  runMigrations?: (migrationUrl: string) => Promise<void>;
  appDb?: Kysely<Database>;
  workerDb?: Kysely<Database>;
  paymentPort?: PaymentPort;
  workerFactory?: (workerDb: Kysely<Database>, paymentPort: PaymentPort) => OutboxWorker;
  listen?: boolean;
  registerSignals?: boolean;
}

export interface ApiRuntime {
  app: FastifyInstance;
  env: Env;
  migrated: boolean;
  worker: OutboxWorker | null;
}

export async function runStartupMigrationsIfEnabled(
  env: Env,
  runMigrations: (migrationUrl: string) => Promise<void> = async (migrationUrl) => {
    await migrateToLatestWithAdvisoryLock(migrationUrl);
  },
): Promise<boolean> {
  if (!env.MIGRATE_ON_START) {
    return false;
  }

  const migrationUrl = env.DATABASE_MIGRATION_URL?.trim();
  if (!migrationUrl) {
    throw new Error("MIGRATE_ON_START=true requires DATABASE_MIGRATION_URL");
  }

  await runMigrations(migrationUrl);
  return true;
}

export async function startApiServer(options: StartupRuntimeOptions = {}): Promise<ApiRuntime> {
  const env = validateEnv(options.rawEnv ?? process.env);

  // Run advisory-locked migrations BEFORE creating HTTP server or listening
  const migrated = await runStartupMigrationsIfEnabled(env, options.runMigrations);

  const ownsAppDb = !options.appDb;
  const appDb =
    options.appDb ??
    createDatabaseClient(env.DATABASE_URL, {
      min: env.DATABASE_POOL_MIN,
      max: env.DATABASE_POOL_MAX,
    });

  const app = buildApp({ db: appDb });

  if (migrated) {
    app.log.info("[database] Startup migrations executed under PostgreSQL advisory lock");
  }

  let worker: OutboxWorker | null = null;
  if (env.RUN_WORKER_IN_PROCESS) {
    const effectiveWorkerDb = options.workerDb ?? appDb;
    const effectivePaymentPort = options.paymentPort ?? paypalAdapter;
    worker = options.workerFactory
      ? options.workerFactory(effectiveWorkerDb, effectivePaymentPort)
      : new OutboxWorker(undefined, effectiveWorkerDb, effectivePaymentPort);
    await worker.start();
    app.log.info(
      "[in-process-worker] Outbox relay, hold reaper, and reconciliation loop active in API process",
    );
  }

  const handleSignal = (): void => {
    void app.close().then(
      () => {
        if (options.listen !== false) {
          process.exit(0);
        }
      },
      (err: unknown) => {
        app.log.error({ err }, "Error during graceful shutdown");
        process.exit(1);
      },
    );
  };

  if (options.registerSignals !== false) {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }

  app.addHook("onClose", async () => {
    if (options.registerSignals !== false) {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    }
    if (worker) {
      await worker.stop();
    }
    if (ownsAppDb) {
      await appDb.destroy();
    }
  });

  if (options.listen !== false) {
    try {
      await app.listen({ port: env.PORT, host: env.HOST });
      app.log.info(`velvetAI API running at http://${env.HOST}:${env.PORT}`);
    } catch (err) {
      app.log.error(err);
      await app.close().catch(() => undefined);
      throw err;
    }
  }

  return { app, env, migrated, worker };
}

if (process.env.NODE_ENV !== "test") {
  startApiServer().catch((err: unknown) => {
    console.error("Failed to start velvetAI API server:", err);
    process.exit(1);
  });
}
