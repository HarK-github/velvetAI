import { describe, it, expect } from "vitest";
import {
  extractDatabaseName,
  assertSafeTestDatabaseUrl,
  assertSafeTestDatabaseTeardown,
  getTestDatabaseUrl,
} from "../test-db.js";

describe("Test Database Isolation Guard", () => {
  it("extracts database name from valid PostgreSQL connection URLs", () => {
    expect(extractDatabaseName("postgresql://user:pass@localhost:5432/velvetai_test")).toBe(
      "velvetai_test",
    );
    expect(extractDatabaseName("postgresql://localhost:5432/my_test_db?sslmode=disable")).toBe(
      "my_test_db",
    );
  });

  it("blocks test startup if configured database is the development database", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5432/velvetai?sslmode=disable"),
    ).toThrowError(
      /TEST STARTUP BLOCKED: Configured database "velvetai" is the development database/,
    );

    expect(() => assertSafeTestDatabaseUrl("postgresql://localhost:5432/velvet_dev")).toThrowError(
      /TEST STARTUP BLOCKED: Configured database "velvet_dev" is the development database/,
    );
  });

  it("blocks test startup if test database does not end with _test safe marker", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5432/production_data"),
    ).toThrowError(
      /TEST STARTUP BLOCKED: Test database name "production_data" must end with "_test"/,
    );

    expect(() => assertSafeTestDatabaseUrl("postgresql://localhost:5432/staging")).toThrowError(
      /TEST STARTUP BLOCKED: Test database name "staging" must end with "_test"/,
    );
  });

  it("permits databases ending in _test or containing _test_", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5432/velvetai_test?sslmode=disable"),
    ).not.toThrow();

    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5432/app_test_shard1"),
    ).not.toThrow();
  });

  it("blocks teardown and fixture cleaning on non-test databases", () => {
    expect(() =>
      assertSafeTestDatabaseTeardown("postgresql://localhost:5432/velvetai"),
    ).toThrowError(
      /TEST TEARDOWN BLOCKED: Refusing to clean or teardown non-test database "velvetai"/,
    );

    expect(() =>
      assertSafeTestDatabaseTeardown("postgresql://localhost:5432/velvetai_test"),
    ).not.toThrow();
  });

  it("getTestDatabaseUrl prefers TEST_DATABASE_URL and blocks unsafe DATABASE_URL", () => {
    const origTestDb = process.env.TEST_DATABASE_URL;
    const origDb = process.env.DATABASE_URL;

    try {
      process.env.TEST_DATABASE_URL = "postgresql://localhost:5432/velvetai_test";
      expect(getTestDatabaseUrl("")).toBe("postgresql://localhost:5432/velvetai_test");
      expect(getTestDatabaseUrl("api")).toBe("postgresql://localhost:5432/velvetai_test_api");
      expect(getTestDatabaseUrl("application")).toBe(
        "postgresql://localhost:5432/velvetai_test_application",
      );
      expect(getTestDatabaseUrl("worker")).toBe("postgresql://localhost:5432/velvetai_test_worker");
      expect(getTestDatabaseUrl("abuse-lab")).toBe(
        "postgresql://localhost:5432/velvetai_test_abuse_lab",
      );
      expect(getTestDatabaseUrl("migration")).toBe(
        "postgresql://localhost:5432/velvetai_test_migration",
      );

      delete process.env.TEST_DATABASE_URL;
      process.env.DATABASE_URL = "postgresql://localhost:5432/velvetai";
      expect(() => getTestDatabaseUrl("")).toThrowError(
        /points to development database "velvetai"/,
      );
    } finally {
      process.env.TEST_DATABASE_URL = origTestDb;
      process.env.DATABASE_URL = origDb;
    }
  });

  it("assertSafeTestDatabaseUrl accepts velvetai_test_api_b and rejects velvetai_b", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5433/velvetai_test_api_b"),
    ).not.toThrow();

    expect(() => assertSafeTestDatabaseUrl("postgresql://localhost:5433/velvetai_b")).toThrowError(
      /must end with "_test" or contain "_test_" safe marker/,
    );
  });

  it("getTestDatabaseUrl supports TEST_DB_SUFFIX for parallel worktrees", () => {
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origTestDb = process.env.TEST_DATABASE_URL;

    try {
      process.env.TEST_DB_SUFFIX = "_b";
      process.env.TEST_DATABASE_URL = "postgresql://localhost:5433/velvetai_test";
      expect(getTestDatabaseUrl("")).toBe("postgresql://localhost:5433/velvetai_test_b");
      expect(getTestDatabaseUrl("api")).toBe("postgresql://localhost:5433/velvetai_test_api_b");
      expect(getTestDatabaseUrl("db")).toBe("postgresql://localhost:5433/velvetai_test_db_b");
      expect(getTestDatabaseUrl("application")).toBe(
        "postgresql://localhost:5433/velvetai_test_application_b",
      );
      expect(getTestDatabaseUrl("worker")).toBe(
        "postgresql://localhost:5433/velvetai_test_worker_b",
      );
      expect(getTestDatabaseUrl("abuse-lab")).toBe(
        "postgresql://localhost:5433/velvetai_test_abuse_lab_b",
      );
      expect(getTestDatabaseUrl("migration")).toBe(
        "postgresql://localhost:5433/velvetai_test_migration_b",
      );
    } finally {
      if (origSuffix !== undefined) {
        process.env.TEST_DB_SUFFIX = origSuffix;
      } else {
        delete process.env.TEST_DB_SUFFIX;
      }
      process.env.TEST_DATABASE_URL = origTestDb;
    }
  });
});
