import { describe, it, expect } from "vitest";
import { createDatabaseClient } from "../index.js";

describe("Database Client Factory", () => {
  it("instantiates Kysely client with postgres dialect", () => {
    const db = createDatabaseClient(
      "postgresql://velvet:velvet_dev_pass@localhost:5432/velvetai?sslmode=disable",
    );
    expect(db).toBeDefined();
    expect(typeof db.selectFrom).toBe("function");
  });
});
