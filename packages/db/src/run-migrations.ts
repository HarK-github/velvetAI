import { createDatabaseClient } from "./client.js";
import { migrateToLatest } from "./migrator.js";

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL || "postgresql://localhost:5432/velvetai?sslmode=disable";

  console.log("Connecting to PostgreSQL to run migrations...");
  const db = createDatabaseClient(databaseUrl);

  try {
    const results = await migrateToLatest(db);
    if (!results || results.length === 0) {
      console.log("Database schema is already up to date. Zero migrations executed.");
    } else {
      for (const result of results) {
        if (result.status === "Success") {
          console.log(`Migration "${result.migrationName}" executed successfully.`);
        } else if (result.status === "Error") {
          console.error(`Migration "${result.migrationName}" failed.`);
        }
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error("Migration execution fatal error:", err);
  process.exit(1);
});
