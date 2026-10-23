import { createDatabaseClient } from "./client.js";
import type { Database } from "./schema.js";
import type { Kysely } from "kysely";

export const DEV_DATABASE_NAMES = new Set(["velvetai", "velvet_dev", "velvet_development"]);

/**
 * Parses the database name from a PostgreSQL connection URI.
 */
export function extractDatabaseName(dbUrl: string): string {
  try {
    const parsed = new URL(dbUrl);
    return parsed.pathname.replace(/^\//, "").split("?")[0] || "";
  } catch (err: any) {
    throw new Error(`Invalid PostgreSQL connection URI: ${err.message}`);
  }
}

/**
 * Asserts that a database URL points to an isolated test database.
 *
 * Safety invariants:
 * 1. Fails immediately if the database name is the development database.
 * 2. Requires database name to end with `_test` or contain `_test_` safe marker.
 */
export function assertSafeTestDatabaseUrl(dbUrl: string): void {
  const dbName = extractDatabaseName(dbUrl);

  if (!dbName) {
    throw new Error("TEST STARTUP BLOCKED: No database name specified in connection URL.");
  }

  if (DEV_DATABASE_NAMES.has(dbName.toLowerCase())) {
    throw new Error(
      `TEST STARTUP BLOCKED: Configured database "${dbName}" is the development database. Integration tests must use an isolated test database (e.g. velvetai_test).`,
    );
  }

  if (!dbName.toLowerCase().endsWith("_test") && !dbName.toLowerCase().includes("_test_")) {
    throw new Error(
      `TEST STARTUP BLOCKED: Test database name "${dbName}" must end with "_test" or contain "_test_" safe marker.`,
    );
  }
}

/**
 * Asserts that database teardown / cleaning only targets a verified test database.
 * Never allows cleaning a non-test database.
 */
export function assertSafeTestDatabaseTeardown(dbUrl: string): void {
  const dbName = extractDatabaseName(dbUrl);
  if (
    DEV_DATABASE_NAMES.has(dbName.toLowerCase()) ||
    (!dbName.toLowerCase().endsWith("_test") && !dbName.toLowerCase().includes("_test_"))
  ) {
    throw new Error(
      `TEST TEARDOWN BLOCKED: Refusing to clean or teardown non-test database "${dbName}".`,
    );
  }
}

/**
 * Resolves the authoritative test database URL.
 * Checks TEST_DATABASE_URL first, then falls back to DATABASE_URL if safe,
 * or defaults to the local test database `postgresql://localhost:5432/velvetai_test?sslmode=disable`.
 * Throws if the resolved URL does not pass safety checks.
 */
export function getTestDatabaseUrl(): string {
  const envTestUrl = process.env.TEST_DATABASE_URL;
  if (envTestUrl && envTestUrl.trim().length > 0) {
    assertSafeTestDatabaseUrl(envTestUrl.trim());
    return envTestUrl.trim();
  }

  const envDbUrl = process.env.DATABASE_URL;
  if (envDbUrl && envDbUrl.trim().length > 0) {
    const dbName = extractDatabaseName(envDbUrl.trim());
    // If DATABASE_URL itself is already pointing to a test db, use it
    if (dbName.toLowerCase().endsWith("_test") || dbName.toLowerCase().includes("_test_")) {
      assertSafeTestDatabaseUrl(envDbUrl.trim());
      return envDbUrl.trim();
    }
    // If DATABASE_URL points to dev db, fail immediately as required by Phase 2 rule 2
    if (DEV_DATABASE_NAMES.has(dbName.toLowerCase())) {
      throw new Error(
        `TEST STARTUP BLOCKED: DATABASE_URL points to development database "${dbName}". Set TEST_DATABASE_URL to an isolated database ending in "_test" (e.g. postgresql://localhost:5432/velvetai_test?sslmode=disable).`,
      );
    }
  }

  const defaultTestUrl = "postgresql://localhost:5432/velvetai_test?sslmode=disable";
  assertSafeTestDatabaseUrl(defaultTestUrl);
  return defaultTestUrl;
}

/**
 * Creates a verified test database client with startup guard.
 */
export function createTestDatabaseClient(
  overrideUrl?: string,
  poolConfig?: { min?: number; max?: number },
): Kysely<Database> {
  const url = overrideUrl || getTestDatabaseUrl();
  assertSafeTestDatabaseUrl(url);
  return createDatabaseClient(url, poolConfig);
}
