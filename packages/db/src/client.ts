import { Kysely, PostgresDialect, sql } from "kysely";
export { Kysely, PostgresDialect, sql };
import pg from "pg";
export { pg };
import { Database } from "./schema.js";

const { Pool, Client } = pg;

export function parseSslConfig(connectionString: string): pg.ConnectionConfig["ssl"] {
  try {
    const parsed = new URL(connectionString);
    const isLocal =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".internal");
    const sslMode = parsed.searchParams.get("sslmode");

    if (sslMode === "disable") {
      return false;
    }
    if (sslMode === "require" || sslMode === "prefer" || !isLocal) {
      return { rejectUnauthorized: false };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createRawPgClient(connectionString: string): pg.Client {
  const ssl = parseSslConfig(connectionString);
  return new Client({ connectionString, ssl });
}

export function createDatabaseClient(
  connectionString: string,
  poolConfig?: { min?: number; max?: number },
): Kysely<Database> {
  const ssl = parseSslConfig(connectionString);
  const pool = new Pool({
    connectionString,
    ssl,
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

/**
 * Executes a callback within an explicit transaction on a single pooled connection,
 * setting the transaction-local user context `app.user_id` for self-membership resolution.
 */
export async function withUserTransaction<T>(
  db: Kysely<Database>,
  userId: string,
  callback: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return await db.transaction().execute(async (trx) => {
    // 3rd argument is 'true' making app.user_id strictly transaction-local
    await sql`SELECT set_config('app.user_id', ${userId}, true)`.execute(trx);
    return await callback(trx as Kysely<Database>);
  });
}
