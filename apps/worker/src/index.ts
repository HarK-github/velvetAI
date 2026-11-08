import { createLogger, validateEnv, loadRootEnv } from "@velvetai/observability";
import { createDatabaseClient, Database } from "@velvetai/db";
import { Kysely } from "kysely";
import { OutboxProcessor, InMemoryOutboxStore, OutboxStore } from "./outbox-processor.js";
import { PostgreSqlOutboxStore } from "./postgres-outbox-store.js";
import { HoldReaperProcessor } from "./hold-reaper.js";
import { ReconciliationProcessor } from "./reconciliation-processor.js";

export * from "./outbox-processor.js";
export * from "./hold-reaper.js";
export * from "./postgres-outbox-store.js";
export * from "./reconciliation-processor.js";

export class OutboxWorker {
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly logger = createLogger({ name: "outbox-worker" });
  readonly processor: OutboxProcessor;
  readonly holdReaper?: HoldReaperProcessor;
  readonly reconciliation?: ReconciliationProcessor;

  constructor(store?: OutboxStore, db?: Kysely<Database>) {
    loadRootEnv();
    validateEnv();

    const isProduction = process.env.NODE_ENV === "production";

    // Requirement 10: Production worker startup must fail if configured with in-memory storage
    if (isProduction && store instanceof InMemoryOutboxStore) {
      throw new Error(
        "InMemoryOutboxStore is prohibited in production; PostgreSqlOutboxStore is required",
      );
    }

    let effectiveStore: OutboxStore;
    if (store) {
      effectiveStore = store;
    } else if (isProduction || process.env.DATABASE_URL) {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error("DATABASE_URL is required for production or PostgreSqlOutboxStore.");
      }
      const dbClient = db || createDatabaseClient(dbUrl);
      effectiveStore = new PostgreSqlOutboxStore(dbClient);
    } else {
      effectiveStore = new InMemoryOutboxStore();
    }

    this.processor = new OutboxProcessor(effectiveStore);

    if (db || process.env.DATABASE_URL) {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error("DATABASE_URL is required for HoldReaperProcessor.");
      }
      const dbClient = db || createDatabaseClient(dbUrl);
      this.holdReaper = new HoldReaperProcessor(dbClient);
    }
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info("Outbox worker started");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info("Outbox worker stopped");
  }

  getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }
}

if (process.env.NODE_ENV !== "test") {
  const worker = new OutboxWorker();
  worker.start().catch((err) => {
    console.error("Worker failed to start:", err);
    process.exit(1);
  });
}
