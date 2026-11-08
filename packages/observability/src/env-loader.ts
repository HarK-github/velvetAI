import fs from "node:fs";
import path from "node:path";
import util from "node:util";

export interface LoadEnvOptions {
  rootDir?: string;
  isTest?: boolean;
  forceReload?: boolean;
}

export interface LoadEnvResult {
  rootDir: string;
  loadedFiles: string[];
  isTest: boolean;
  databaseName?: string;
}

let hasLoaded = false;
let lastLoadedRootDir: string | null = null;

/**
 * Parses the database name from a PostgreSQL connection URI without leaking credentials.
 */
export function extractDatabaseName(dbUrl: string): string {
  try {
    const parsed = new URL(dbUrl);
    return parsed.pathname.replace(/^\//, "").split("?")[0] || "";
  } catch {
    return "";
  }
}

/**
 * Traverses up directory tree from startDir to locate the repository root
 * identified by the presence of pnpm-workspace.yaml.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(startDir);
}

/**
 * Safely parses a key-value env file using Node.js built-in util.parseEnv.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = util.parseEnv(content);
    const result: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === "string") {
        result[key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Authoritative Root Environment Loader for velvetAI.
 *
 * Precedence Rules:
 * 1. Process environment (process.env variables set prior to loading) always takes highest precedence.
 * 2. .env.local overrides .env for machine/worktree-local configuration (ports, test suffix, local DB).
 * 3. In test mode (NODE_ENV === "test"), .env.test is loaded for test defaults (e.g. OIDC_MOCK_ENABLED=true).
 *    Decision: .env.test must NEVER override TEST_DB_SUFFIX. TEST_DB_SUFFIX is a worktree-local isolation
 *    marker (e.g., _b for Track B) configured in .env.local. Overriding it would break parallel test isolation.
 * 4. In test mode, if DATABASE_URL points to a non-test database, it is safely remapped to the test database.
 */
export function loadRootEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : findRepoRoot();

  if (hasLoaded && lastLoadedRootDir === rootDir && !options.forceReload) {
    const currentDb = process.env.DATABASE_URL;
    return {
      rootDir,
      loadedFiles: [],
      isTest: process.env.NODE_ENV === "test",
      databaseName: currentDb ? extractDatabaseName(currentDb) : undefined,
    };
  }

  // Snapshot initial process environment to ensure existing process variables take ultimate precedence
  const initialProcessEnv: Record<string, string | undefined> = { ...process.env };

  const isTest =
    options.isTest !== undefined
      ? options.isTest
      : initialProcessEnv.NODE_ENV === "test" || process.env.NODE_ENV === "test";

  const envPath = path.join(rootDir, ".env");
  const localPath = path.join(rootDir, ".env.local");
  const testPath = path.join(rootDir, ".env.test");

  const loadedFiles: string[] = [];

  // 1. Base .env
  const baseEnv = parseEnvFile(envPath);
  if (Object.keys(baseEnv).length > 0) loadedFiles.push(envPath);

  // 2. Local overrides .env.local
  const localEnv = parseEnvFile(localPath);
  if (Object.keys(localEnv).length > 0) loadedFiles.push(localPath);

  // Merge base and local (.env.local overrides .env)
  const merged: Record<string, string> = {
    ...baseEnv,
    ...localEnv,
  };

  // 3. Test mode defaults (.env.test)
  if (isTest) {
    const testEnv = parseEnvFile(testPath);
    if (Object.keys(testEnv).length > 0) loadedFiles.push(testPath);

    // Apply testEnv, enforcing that .env.test NEVER overrides TEST_DB_SUFFIX
    for (const [key, val] of Object.entries(testEnv)) {
      if (key === "TEST_DB_SUFFIX") {
        // Forbidden: .env.test must not override TEST_DB_SUFFIX
        continue;
      }
      if (localEnv[key] !== undefined) {
        // If .env.local explicitly specified this variable, keep .env.local's value
        continue;
      }
      merged[key] = val;
    }

    // Ensure NODE_ENV is set to test
    merged.NODE_ENV = "test";

    // In test mode, if DATABASE_URL points to dev DB, redirect to TEST_DATABASE_URL if available
    if (merged.DATABASE_URL) {
      const rawDbName = extractDatabaseName(merged.DATABASE_URL).toLowerCase();
      const isTestDb = rawDbName.endsWith("_test") || rawDbName.includes("_test_");
      if (!isTestDb && merged.TEST_DATABASE_URL) {
        merged.DATABASE_URL = merged.TEST_DATABASE_URL;
      }
    } else if (merged.TEST_DATABASE_URL) {
      merged.DATABASE_URL = merged.TEST_DATABASE_URL;
    }
  }

  // 4. Apply merged values to process.env where process.env did not already have a value
  for (const [key, val] of Object.entries(merged)) {
    if (initialProcessEnv[key] === undefined) {
      process.env[key] = val;
    }
  }

  hasLoaded = true;
  lastLoadedRootDir = rootDir;

  const resolvedDbUrl = process.env.DATABASE_URL;
  return {
    rootDir,
    loadedFiles,
    isTest,
    databaseName: resolvedDbUrl ? extractDatabaseName(resolvedDbUrl) : undefined,
  };
}

/**
 * Asserts that DATABASE_URL is defined and returns it, or throws a clear error.
 */
export function requireDatabaseUrl(contextName: string = "Operation", rootDir?: string): string {
  loadRootEnv({ rootDir, forceReload: Boolean(rootDir) });
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    throw new Error(
      `DATABASE_URL is required for ${contextName} but was not found in environment, .env.local, or .env.`,
    );
  }
  return dbUrl.trim();
}
