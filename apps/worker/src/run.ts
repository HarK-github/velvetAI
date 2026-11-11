import { OutboxWorker } from "./index.js";

async function runStandalone(): Promise<void> {
  const worker = new OutboxWorker();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[worker] Received ${signal}, stopping outbox worker cleanly...`);
    await worker.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await worker.start();
}

runStandalone().catch((err: unknown) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
