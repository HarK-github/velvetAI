import { describe, it, expect, beforeAll } from "vitest";
import {
  extractDatabaseName,
  assertSafeTestDatabaseUrl,
  assertSafeTestDatabaseTeardown,
  getTestDatabaseUrl,
  resolvePackageTestDatabaseName,
} from "../test-db.js";
import { loadRootEnv } from "@velvetai/observability";

describe("Test Database Isolation Guard", () => {
  beforeAll(() => {
    loadRootEnv({ isTest: true });
  });
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
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origPkg = process.env.TEST_PACKAGE_NAME;

    try {
      delete process.env.TEST_DB_SUFFIX;
      delete process.env.TEST_PACKAGE_NAME;
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
      if (origSuffix !== undefined) {
        process.env.TEST_DB_SUFFIX = origSuffix;
      } else {
        delete process.env.TEST_DB_SUFFIX;
      }
      if (origPkg !== undefined) {
        process.env.TEST_PACKAGE_NAME = origPkg;
      } else {
        delete process.env.TEST_PACKAGE_NAME;
      }
    }
  });

  it("assertSafeTestDatabaseUrl accepts velvetai_test_api_b and rejects velvetai_b", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgresql://localhost:5433/velvetai_test_api_b"),
    ).not.toThrow();

    expect(() => assertSafeTestDatabaseUrl("postgresql://localhost:5433/velvetai_b")).toThrowError(
      /(must end with "_test" or contain "_test_" safe marker|is the development database)/,
    );
  });

  it("resolves per-package test database when TEST_PACKAGE_NAME is set without argument", () => {
    const origPkg = process.env.TEST_PACKAGE_NAME;
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origTestDb = process.env.TEST_DATABASE_URL;

    try {
      process.env.TEST_DATABASE_URL = "postgresql://localhost:5432/velvetai_test";
      delete process.env.TEST_DB_SUFFIX;

      process.env.TEST_PACKAGE_NAME = "worker";
      expect(getTestDatabaseUrl()).toBe("postgresql://localhost:5432/velvetai_test_worker");

      process.env.TEST_PACKAGE_NAME = "api";
      expect(getTestDatabaseUrl()).toBe("postgresql://localhost:5432/velvetai_test_api");

      process.env.TEST_PACKAGE_NAME = "application";
      expect(getTestDatabaseUrl()).toBe("postgresql://localhost:5432/velvetai_test_application");

      process.env.TEST_PACKAGE_NAME = "db";
      expect(getTestDatabaseUrl()).toBe("postgresql://localhost:5432/velvetai_test_db");

      // With worktree suffix
      process.env.TEST_DB_SUFFIX = "_b";
      process.env.TEST_PACKAGE_NAME = "worker";
      expect(getTestDatabaseUrl()).toBe("postgresql://localhost:5432/velvetai_test_worker_b");
    } finally {
      process.env.TEST_PACKAGE_NAME = origPkg;
      process.env.TEST_DB_SUFFIX = origSuffix;
      process.env.TEST_DATABASE_URL = origTestDb;
    }
  });

  it("getTestDatabaseUrl supports TEST_DB_SUFFIX for parallel worktrees", () => {
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origTestDb = process.env.TEST_DATABASE_URL;
    const origPkg = process.env.TEST_PACKAGE_NAME;

    try {
      delete process.env.TEST_PACKAGE_NAME;
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
      if (origPkg !== undefined) {
        process.env.TEST_PACKAGE_NAME = origPkg;
      } else {
        delete process.env.TEST_PACKAGE_NAME;
      }
    }
  });

  it("resolves api DB as velvetai_test_api_b when TEST_DB_SUFFIX=_b and TEST_DATABASE_URL base is velvetai_test", () => {
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origTestDb = process.env.TEST_DATABASE_URL;
    const origPkg = process.env.TEST_PACKAGE_NAME;

    try {
      delete process.env.TEST_PACKAGE_NAME;
      process.env.TEST_DB_SUFFIX = "_b";
      process.env.TEST_DATABASE_URL = "postgresql://localhost:5432/velvetai_test?sslmode=disable";
      expect(getTestDatabaseUrl("api")).toBe(
        "postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable",
      );
    } finally {
      if (origSuffix !== undefined) {
        process.env.TEST_DB_SUFFIX = origSuffix;
      } else {
        delete process.env.TEST_DB_SUFFIX;
      }
      process.env.TEST_DATABASE_URL = origTestDb;
      if (origPkg !== undefined) {
        process.env.TEST_PACKAGE_NAME = origPkg;
      } else {
        delete process.env.TEST_PACKAGE_NAME;
      }
    }
  });

  it("never appends suffix twice if the base or resolved database name already ends with the suffix", () => {
    const origSuffix = process.env.TEST_DB_SUFFIX;
    const origTestDb = process.env.TEST_DATABASE_URL;
    const origPkg = process.env.TEST_PACKAGE_NAME;

    try {
      delete process.env.TEST_PACKAGE_NAME;
      process.env.TEST_DB_SUFFIX = "_b";

      // 1. Base URL already ends with _b (e.g. velvetai_test_b)
      process.env.TEST_DATABASE_URL = "postgresql://localhost:5432/velvetai_test_b?sslmode=disable";
      expect(getTestDatabaseUrl("")).toBe(
        "postgresql://localhost:5432/velvetai_test_b?sslmode=disable",
      );
      expect(getTestDatabaseUrl("api")).toBe(
        "postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable",
      );
      expect(getTestDatabaseUrl("db")).toBe(
        "postgresql://localhost:5432/velvetai_test_db_b?sslmode=disable",
      );

      // 2. Base URL already has package and suffix (e.g. velvetai_test_api_b)
      process.env.TEST_DATABASE_URL =
        "postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable";
      expect(getTestDatabaseUrl("")).toBe(
        "postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable",
      );
      expect(getTestDatabaseUrl("api")).toBe(
        "postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable",
      );

      // 3. Direct resolvePackageTestDatabaseName invocations
      expect(resolvePackageTestDatabaseName("velvetai_test_b", "")).toBe("velvetai_test_b");
      expect(resolvePackageTestDatabaseName("velvetai_test_b", "api")).toBe("velvetai_test_api_b");
      expect(resolvePackageTestDatabaseName("velvetai_test_api_b", "api")).toBe(
        "velvetai_test_api_b",
      );
      expect(resolvePackageTestDatabaseName("velvetai_test_api_b", "")).toBe("velvetai_test_api_b");
      expect(resolvePackageTestDatabaseName("velvetai_test_api", "api")).toBe(
        "velvetai_test_api_b",
      );
    } finally {
      if (origSuffix !== undefined) {
        process.env.TEST_DB_SUFFIX = origSuffix;
      } else {
        delete process.env.TEST_DB_SUFFIX;
      }
      process.env.TEST_DATABASE_URL = origTestDb;
      if (origPkg !== undefined) {
        process.env.TEST_PACKAGE_NAME = origPkg;
      } else {
        delete process.env.TEST_PACKAGE_NAME;
      }
    }
  });

  it("in NODE_ENV=test, getTestDatabaseUrl() throws when TEST_PACKAGE_NAME is missing", () => {
    const origPkg = process.env.TEST_PACKAGE_NAME;
    const origNodeEnv = process.env.NODE_ENV;

    try {
      process.env.NODE_ENV = "test";
      delete process.env.TEST_PACKAGE_NAME;

      expect(() => getTestDatabaseUrl()).toThrowError(
        /TEST CONFIGURATION ERROR: TEST_PACKAGE_NAME is missing in NODE_ENV=test/,
      );
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origPkg !== undefined) {
        process.env.TEST_PACKAGE_NAME = origPkg;
      } else {
        delete process.env.TEST_PACKAGE_NAME;
      }
    }
  });
});
