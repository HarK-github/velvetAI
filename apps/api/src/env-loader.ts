import fs from "node:fs";
import path from "node:path";

function loadIfExists(filePath: string) {
  if (fs.existsSync(filePath) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(filePath);
    } catch {
      // Ignore parse/read errors
    }
  }
}

// Find repository root
let rootDir = process.cwd();
for (let i = 0; i < 5; i++) {
  if (fs.existsSync(path.join(rootDir, "pnpm-workspace.yaml"))) {
    break;
  }
  const parent = path.dirname(rootDir);
  if (parent === rootDir) break;
  rootDir = parent;
}

if (process.env.NODE_ENV === "test") {
  // 1. In test environment, load isolated test environment
  loadIfExists(path.join(rootDir, ".env.test"));
  const testDbUrl =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://localhost:5432/velvetai_test?sslmode=disable";
  process.env.DATABASE_URL = testDbUrl;
  process.env.TEST_DATABASE_URL = testDbUrl;
} else {
  // 1. Load base .env
  loadIfExists(path.join(rootDir, ".env"));
  // 2. Load .env.local override if present
  loadIfExists(path.join(rootDir, ".env.local"));
}
