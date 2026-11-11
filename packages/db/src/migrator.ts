import { Kysely, Migration, MigrationProvider, Migrator } from "kysely";
import { createDatabaseClient, createRawPgClient } from "./client.js";
import { Database } from "./schema.js";
import * as initialSchema from "./migrations/0001_initial_schema.js";
import * as slotClaimRlsHardening from "./migrations/0002_slot_claim_rls_hardening.js";
import * as paymentCoreLedger from "./migrations/0003_payment_core_ledger.js";
import * as outboxLeaseHardening from "./migrations/0004_outbox_lease_hardening.js";
import * as selfMembershipRls from "./migrations/0005_self_membership_rls.js";
import * as judgeTenantSeedAndReset from "./migrations/0007_judge_tenant_seed_and_reset.js";
import * as judgeAbuseRuns from "./migrations/0009_judge_abuse_runs.js";

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "0001_initial_schema": {
        up: initialSchema.up,
        down: initialSchema.down,
      },
      "0002_slot_claim_rls_hardening": {
        up: slotClaimRlsHardening.up,
        down: slotClaimRlsHardening.down,
      },
      "0003_payment_core_ledger": {
        up: paymentCoreLedger.up,
        down: paymentCoreLedger.down,
      },
      "0004_outbox_lease_hardening": {
        up: outboxLeaseHardening.up,
        down: outboxLeaseHardening.down,
      },
      "0005_self_membership_rls": {
        up: selfMembershipRls.up,
        down: selfMembershipRls.down,
      },
      "0007_judge_tenant_seed_and_reset": {
        up: judgeTenantSeedAndReset.up,
        down: judgeTenantSeedAndReset.down,
      },
      "0009_judge_abuse_runs": {
        up: judgeAbuseRuns.up,
        down: judgeAbuseRuns.down,
      },
    };
  }
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: new StaticMigrationProvider(),
    allowUnorderedMigrations: true,
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

export const MIGRATION_ADVISORY_LOCK_ID = "873421901234567";

/**
 * Executes a migration callback under a PostgreSQL session-level advisory lock
 * using a direct (non-pooled) connection so concurrent instance startups serialize safely.
 */
export async function withMigrationAdvisoryLock<T>(
  connectionString: string,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const lockClient = createRawPgClient(connectionString);
  await lockClient.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    const db = createDatabaseClient(connectionString, { min: 1, max: 2 });
    try {
      return await fn(db);
    } finally {
      await db.destroy();
    }
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_ADVISORY_LOCK_ID]);
    } catch {
      // Connection teardown below also releases any session-scoped advisory lock.
    }
    await lockClient.end().catch(() => undefined);
  }
}

export async function migrateToLatestWithAdvisoryLock(connectionString: string) {
  return withMigrationAdvisoryLock(connectionString, async (db) => migrateToLatest(db));
}
