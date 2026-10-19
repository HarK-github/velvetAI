import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { Database } from "./schema.js";

const { Pool } = pg;

export function createDatabaseClient(
  connectionString: string,
  poolConfig?: { min?: number; max?: number },
): Kysely<Database> {
  const pool = new Pool({
    connectionString,
    min: poolConfig?.min ?? 2,
    max: poolConfig?.max ?? 10,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}
