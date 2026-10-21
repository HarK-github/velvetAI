import { Kysely, PostgresDialect, sql } from "kysely";
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

/**
 * Executes a callback within an explicit transaction on a single pooled connection,
 * setting the transaction-local tenant context `app.tenant_id` per Amendment C.2.
 */
export async function withTenantTransaction<T>(
  db: Kysely<Database>,
  tenantId: string,
  callback: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return await db.transaction().execute(async (trx) => {
    // 3rd argument is 'true' making app.tenant_id strictly transaction-local
    await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
    return await callback(trx as Kysely<Database>);
  });
}
