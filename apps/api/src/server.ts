import "./env-loader.js";
import { buildApp } from "./app.js";
import { validateEnv } from "@velvetai/observability";
import { OutboxWorker } from "@velvetai/worker";

async function main() {
  const env = validateEnv();
  const app = buildApp();

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

