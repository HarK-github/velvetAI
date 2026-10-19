import { buildApp } from "./app.js";
import { validateEnv } from "@velvetai/observability";

async function main() {
  const env = validateEnv();
  const app = buildApp();

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
