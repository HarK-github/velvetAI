import { createLogger, validateEnv, loadRootEnv } from "@velvetai/observability";
import { createDatabaseClient, Database } from "@velvetai/db";
import { PaymentPort } from "@velvetai/application";
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
  private activeCycle: Promise<void> | null = null;
  private ownedDb: Kysely<Database> | null = null;
  private readonly logger = createLogger({ name: "outbox-worker" });
  readonly processor: OutboxProcessor;
  readonly holdReaper?: HoldReaperProcessor;
  readonly reconciliation?: ReconciliationProcessor;

  constructor(store?: OutboxStore, db?: Kysely<Database>, paymentPort?: PaymentPort) {
    loadRootEnv();
    const env = validateEnv();

    const isProduction = process.env.NODE_ENV === "production";

    // Requirement 10: Production worker startup must fail if configured with in-memory storage
    if (isProduction && store instanceof InMemoryOutboxStore) {
      throw new Error(
        "InMemoryOutboxStore is prohibited in production; PostgreSqlOutboxStore is required",
      );
    }

    let dbClient: Kysely<Database> | null = db ?? null;
    const ensureDbClient = (): Kysely<Database> => {
      if (dbClient) {
        return dbClient;
      }
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error("DATABASE_URL is required for production or PostgreSqlOutboxStore.");
      }
      this.ownedDb = createDatabaseClient(dbUrl, {
        min: env.DATABASE_POOL_MIN,
        max: env.DATABASE_POOL_MAX,
      });
      dbClient = this.ownedDb;
      return dbClient;
    };

    let effectiveStore: OutboxStore;
    if (store) {
      effectiveStore = store;
    } else if (isProduction || process.env.DATABASE_URL) {
      effectiveStore = new PostgreSqlOutboxStore(ensureDbClient());
    } else {
      effectiveStore = new InMemoryOutboxStore();
    }

    this.processor = new OutboxProcessor(effectiveStore);

    if (db || process.env.DATABASE_URL) {
      const client = ensureDbClient();
      this.holdReaper = new HoldReaperProcessor(client);
      if (paymentPort) {
        this.reconciliation = new ReconciliationProcessor(client, paymentPort);
      }
    }
  }

  async runOnce(): Promise<void> {
    try {
      await this.processor.processNextBatch(20);
      if (this.holdReaper) {
        await this.holdReaper.reapOnce(50);
      }
      if (this.reconciliation) {
        await this.reconciliation.reconcilePendingOperations(20);
      }
    } catch (err) {
      this.logger.error({ err }, "Error in outbox worker background cycle");
    }
  }

  async start(intervalMs = 2000): Promise<void> {
    this.isRunning = true;
    this.logger.info("Outbox worker started");

    if (intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        if (!this.isRunning || this.activeCycle) {
          return;
        }
        this.activeCycle = this.runOnce().finally(() => {
          this.activeCycle = null;
        });
      }, intervalMs);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeCycle) {
      await this.activeCycle;
    }
    if (this.ownedDb) {
      const dbToClose = this.ownedDb;
      this.ownedDb = null;
      await dbToClose.destroy();
    }
    this.logger.info("Outbox worker stopped");
  }

  getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }
}
