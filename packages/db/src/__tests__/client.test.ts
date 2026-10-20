import { describe, it, expect } from "vitest";
import { createDatabaseClient, createMigrator } from "../index.js";

describe("Database Client & Migrations", () => {
  it("instantiates Kysely client with postgres dialect", () => {
    const db = createDatabaseClient(
      "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable",
    );
    expect(db).toBeDefined();
    expect(typeof db.selectFrom).toBe("function");
  });

  it("configures Kysely migrator with static migrations", async () => {
    const db = createDatabaseClient(
      "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable",
    );
    const migrator = createMigrator(db);
    expect(migrator).toBeDefined();
    expect(typeof migrator.migrateToLatest).toBe("function");
    expect(typeof migrator.migrateDown).toBe("function");
  });
});
