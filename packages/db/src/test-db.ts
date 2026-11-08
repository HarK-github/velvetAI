import { createDatabaseClient } from "./client.js";
import type { Database } from "./schema.js";
import type { Kysely } from "kysely";
import { loadRootEnv } from "@velvetai/observability";

export const DEV_DATABASE_NAMES = new Set([
  "velvetai",
  "velvetai_b",
  "velvet_dev",
  "velvet_development",
]);

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
 * Detects the calling workspace package name to provide isolated test databases.
 */
export function detectCurrentPackageName(): string | undefined {
  if (process.env.TEST_PACKAGE_NAME) {
    return process.env.TEST_PACKAGE_NAME;
  }
  if (process.env.npm_package_name) {
    return process.env.npm_package_name.replace(/^@velvetai\//, "").replace(/-/g, "_");
  }
  const cwd = process.cwd();
  if (cwd.includes("packages/db")) return "db";
  if (cwd.includes("packages/application")) return "application";
  if (cwd.includes("apps/api")) return "api";
  if (cwd.includes("apps/worker")) return "worker";
  if (cwd.includes("apps/abuse-lab")) return "abuse_lab";
  return undefined;
}

/**
 * Resolves the isolated per-package test database name based on base name and package.
 */
export function resolvePackageTestDatabaseName(baseName: string, packageName?: string): string {
  const pkg = (packageName !== undefined ? packageName : detectCurrentPackageName() || "").trim();
  const suffix = (process.env.TEST_DB_SUFFIX ?? "").trim();
  const cleanPkg = pkg.replace(/^@velvetai\//, "").replace(/-/g, "_");

  if (!cleanPkg) {
    if (suffix && !baseName.endsWith(suffix)) {
      return `${baseName}${suffix}`;
    }
    return baseName;
  }

  const expectedSuffix = `${cleanPkg}${suffix}`;
  if (baseName.endsWith(`_${expectedSuffix}`)) {
    return baseName;
  }
  if (suffix && baseName.endsWith(`_${cleanPkg}`)) {
    return `${baseName}${suffix}`;
  }
  return `${baseName}_${expectedSuffix}`;
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
 * In multitenant turbo parallel execution, derives per-package isolated database URLs
 * (e.g. velvetai_test_db, velvetai_test_application, velvetai_test_api, velvetai_test_worker, velvetai_test_abuse_lab).
 * Throws if the resolved URL does not pass safety checks.
 */
export function getTestDatabaseUrl(packageName?: string): string {
  loadRootEnv({ isTest: true });
  const envTestUrl = process.env.TEST_DATABASE_URL;
  let resolvedUrl: string;

  if (envTestUrl && envTestUrl.trim().length > 0) {
    resolvedUrl = envTestUrl.trim();
  } else {
    const envDbUrl = process.env.DATABASE_URL;
    if (envDbUrl && envDbUrl.trim().length > 0) {
      const dbName = extractDatabaseName(envDbUrl.trim());
      // If DATABASE_URL itself is already pointing to a test db, use it
      if (dbName.toLowerCase().endsWith("_test") || dbName.toLowerCase().includes("_test_")) {
        resolvedUrl = envDbUrl.trim();
      } else if (DEV_DATABASE_NAMES.has(dbName.toLowerCase())) {
        throw new Error(
          `TEST STARTUP BLOCKED: DATABASE_URL points to development database "${dbName}". Set TEST_DATABASE_URL to an isolated database ending in "_test" (e.g. postgresql://localhost:5432/velvetai_test?sslmode=disable).`,
        );
      } else {
        const host = process.env.POSTGRES_HOST || "localhost";
        const port = process.env.POSTGRES_PORT || "5432";
        resolvedUrl = `postgresql://${host}:${port}/velvetai_test?sslmode=disable`;
      }
    } else {
      const host = process.env.POSTGRES_HOST || "localhost";
      const port = process.env.POSTGRES_PORT || "5432";
      resolvedUrl = `postgresql://${host}:${port}/velvetai_test?sslmode=disable`;
    }
  }

  // Derive per-package database if package detected or specified, or if TEST_DB_SUFFIX is set
  const pkg = packageName !== undefined ? packageName : detectCurrentPackageName();
  const suffix = (process.env.TEST_DB_SUFFIX ?? "").trim();
  if (pkg !== undefined || suffix) {
    const parsed = new URL(resolvedUrl);
    const baseDbName = extractDatabaseName(resolvedUrl);
    const targetDbName = resolvePackageTestDatabaseName(baseDbName, pkg);
    parsed.pathname = `/${targetDbName}`;
    resolvedUrl = parsed.toString();
  }

  assertSafeTestDatabaseUrl(resolvedUrl);
  return resolvedUrl;
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
