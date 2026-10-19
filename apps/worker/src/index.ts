import { createLogger, validateEnv } from "@velvetai/observability";

export class OutboxWorker {
  private isRunning = false;
  private readonly logger = createLogger({ name: "outbox-worker" });

  constructor() {
    validateEnv();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info("Outbox worker started");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
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
