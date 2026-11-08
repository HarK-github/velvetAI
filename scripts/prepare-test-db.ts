import {
  createDatabaseClient,
  createRawPgClient,
  migrateToLatest,
  getTestDatabaseUrl,
  extractDatabaseName,
} from "../packages/db/src/index.js";

const TEST_PACKAGES = [
  "", // velvetai_test (base)
  "db", // velvetai_test_db
  "migration", // velvetai_test_migration
  "application", // velvetai_test_application
  "api", // velvetai_test_api
  "worker", // velvetai_test_worker
  "abuse_lab", // velvetai_test_abuse_lab
];

async function main() {
  const port = process.env.POSTGRES_PORT || "5432";
  const baseTestUrl =
    process.env.TEST_DATABASE_URL || `postgresql://localhost:${port}/velvetai_test?sslmode=disable`;
  const parsed = new URL(baseTestUrl);
  parsed.pathname = "/postgres";
  const maintenanceUrl = parsed.toString();

  console.log("Connecting to PostgreSQL maintenance database...");
  const adminClient = createRawPgClient(maintenanceUrl);
  await adminClient.connect();

  const existingRes = await adminClient.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'velvetai_test%'",
  );
  const existingDbs = new Set(existingRes.rows.map((r) => r.datname));

  for (const pkg of TEST_PACKAGES) {
    const pkgDbUrl = getTestDatabaseUrl(pkg);
    const dbName = extractDatabaseName(pkgDbUrl);

    if (!existingDbs.has(dbName)) {
      console.log(`Creating database "${dbName}"...`);
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      existingDbs.add(dbName);
    } else {
      console.log(`Database "${dbName}" exists.`);
    }

    // Run migrations
    console.log(`Running migrations for "${dbName}"...`);
    const dbClient = createDatabaseClient(pkgDbUrl, { min: 1, max: 2 });
    try {
      await migrateToLatest(dbClient);
      console.log(`✓ Migrations up to date for "${dbName}".`);
    } finally {
      await dbClient.destroy();
    }
  }

  await adminClient.end();
  console.log("All test databases prepared and migrated successfully.");
}

main().catch((err) => {
  console.error("FATAL: Failed to prepare test databases:", err);
  process.exit(1);
});
