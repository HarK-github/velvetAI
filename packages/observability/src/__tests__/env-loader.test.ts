import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadRootEnv,
  extractDatabaseName,
  requireDatabaseUrl,
  findRepoRoot,
} from "../env-loader.js";

describe("Authoritative Root Env Loader", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "velvetai-env-test-"));
    // Create workspace marker so findRepoRoot stops here
    fs.writeFileSync(path.join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("extracts database name from PostgreSQL URI correctly", () => {
    expect(extractDatabaseName("postgresql://localhost:5432/velvetai")).toBe("velvetai");
    expect(extractDatabaseName("postgresql://user:pass@host:5432/velvetai_b?sslmode=disable")).toBe(
      "velvetai_b",
    );
    expect(
      extractDatabaseName("postgresql://localhost:5432/velvetai_test_api_b?sslmode=disable"),
    ).toBe("velvetai_test_api_b");
    expect(extractDatabaseName("invalid-uri")).toBe("");
  });

  it("discovers repo root via pnpm-workspace.yaml", () => {
    const subDir = path.join(tempDir, "packages", "db", "src");
    fs.mkdirSync(subDir, { recursive: true });
    expect(findRepoRoot(subDir)).toBe(tempDir);
  });

  it("enforces precedence: process.env > .env.local > .env", () => {
    fs.writeFileSync(
      path.join(tempDir, ".env"),
      "PORT=3000\nWEB_PORT=5173\nDB_NAME=base_db\nSHARED_VAR=from_base\n",
    );
    fs.writeFileSync(
      path.join(tempDir, ".env.local"),
      "PORT=3001\nWEB_PORT=5174\nDB_NAME=local_db\nLOCAL_ONLY=from_local\n",
    );

    // Set a process.env variable that should beat both files
    process.env.PORT = "9999";
    delete process.env.WEB_PORT;
    delete process.env.DB_NAME;
    delete process.env.SHARED_VAR;
    delete process.env.LOCAL_ONLY;

    const result = loadRootEnv({ rootDir: tempDir, forceReload: true, isTest: false });

    expect(result.loadedFiles).toHaveLength(2);
    // Process env takes highest precedence
    expect(process.env.PORT).toBe("9999");
    // .env.local overrides .env
    expect(process.env.WEB_PORT).toBe("5174");
    expect(process.env.DB_NAME).toBe("local_db");
    // .env provides base
    expect(process.env.SHARED_VAR).toBe("from_base");
    // .env.local provides local-only
    expect(process.env.LOCAL_ONLY).toBe("from_local");
  });

  it("guarantees .env.test NEVER overrides TEST_DB_SUFFIX from .env.local", () => {
    fs.writeFileSync(
      path.join(tempDir, ".env"),
      "DATABASE_URL=postgresql://localhost:5432/velvetai\nTEST_DATABASE_URL=postgresql://localhost:5432/velvetai_test\n",
    );
    fs.writeFileSync(
      path.join(tempDir, ".env.local"),
      "TEST_DB_SUFFIX=_b\nDATABASE_URL=postgresql://localhost:5432/velvetai_b\nTEST_DATABASE_URL=postgresql://localhost:5432/velvetai_test_b\n",
    );
    fs.writeFileSync(
      path.join(tempDir, ".env.test"),
      "NODE_ENV=test\nTEST_DB_SUFFIX=_test_default_forbidden\nDATABASE_URL=postgresql://localhost:5432/velvetai_test\nOIDC_MOCK_ENABLED=true\n",
    );

    delete process.env.TEST_DB_SUFFIX;
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    delete process.env.OIDC_MOCK_ENABLED;

    const result = loadRootEnv({ rootDir: tempDir, forceReload: true, isTest: true });

    expect(result.isTest).toBe(true);
    // TEST_DB_SUFFIX must come from .env.local (_b), never from .env.test
    expect(process.env.TEST_DB_SUFFIX).toBe("_b");
    // Test defaults are applied
    expect(process.env.OIDC_MOCK_ENABLED).toBe("true");
    // Explicit local test database url is preserved
    expect(process.env.TEST_DATABASE_URL).toBe("postgresql://localhost:5432/velvetai_test_b");
  });

  it("requireDatabaseUrl fails with clear error when DATABASE_URL is missing", () => {
    fs.writeFileSync(path.join(tempDir, ".env"), "PORT=3000\n");
    delete process.env.DATABASE_URL;

    expect(() => requireDatabaseUrl("Unit Test Runner", tempDir)).toThrow(
      /DATABASE_URL is required for Unit Test Runner but was not found/,
    );
  });
});
