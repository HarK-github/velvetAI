import { describe, it, expect } from "vitest";
import {
  createDatabaseClient,
  createMigrator,
  getTestDatabaseUrl,
  parseSslConfig,
  withMigrationAdvisoryLock,
} from "../index.js";

describe("Database Client & Migrations", () => {
  const testUrl = getTestDatabaseUrl();

  it("instantiates Kysely client with postgres dialect", () => {
    const db = createDatabaseClient(testUrl);
    expect(db).toBeDefined();
    expect(typeof db.selectFrom).toBe("function");
  });

  it("configures Kysely migrator with static migrations", async () => {
    const db = createDatabaseClient(testUrl);
    const migrator = createMigrator(db);
    expect(migrator).toBeDefined();
    expect(typeof migrator.migrateToLatest).toBe("function");
    expect(typeof migrator.migrateDown).toBe("function");
  });

  it("enables TLS for Neon pooled and direct sslmode=require URLs and disables for local sslmode=disable", () => {
    expect(
      parseSslConfig(
        "postgresql://velvet_runtime:secret@ep-cool-rain-1234-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toEqual({ rejectUnauthorized: false });

    expect(
      parseSslConfig(
        "postgresql://neondb_owner:secret@ep-cool-rain-1234.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      ),
    ).toEqual({ rejectUnauthorized: false });

    expect(parseSslConfig("postgresql://localhost:5432/velvetai?sslmode=disable")).toBe(false);
  });

  it("serializes concurrent migration callers via PostgreSQL advisory lock", async () => {
    const events: string[] = [];

    const first = withMigrationAdvisoryLock(testUrl, async () => {
      events.push("first:enter");
      await new Promise((resolve) => setTimeout(resolve, 120));
      events.push("first:exit");
      return "first-done";
    });

    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = withMigrationAdvisoryLock(testUrl, async () => {
      events.push("second:enter");
      events.push("second:exit");
      return "second-done";
    });

    const results = await Promise.all([first, second]);
    expect(results).toEqual(["first-done", "second-done"]);
    expect(events).toEqual(["first:enter", "first:exit", "second:enter", "second:exit"]);
  });
});
