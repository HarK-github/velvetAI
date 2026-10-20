import { Kysely, Migration, MigrationProvider, Migrator } from "kysely";
import { Database } from "./schema.js";
import * as initialSchema from "./migrations/0001_initial_schema.js";

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "0001_initial_schema": {
        up: initialSchema.up,
        down: initialSchema.down,
      },
    };
  }
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
  });
}

export async function migrateToLatest(db: Kysely<Database>) {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error;
  }
  return results;
}

export async function migrateDown(db: Kysely<Database>) {
  const migrator = createMigrator(db);
  const { error, results } = await migrator.migrateDown();
  if (error) {
    throw error;
  }
  return results;
}
