import { describe, it, expect } from "vitest";
import { createDatabaseClient, createMigrator, getTestDatabaseUrl } from "../index.js";

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
});
