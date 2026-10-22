import { Kysely, Migration, MigrationProvider, Migrator } from "kysely";
import { Database } from "./schema.js";
import * as initialSchema from "./migrations/0001_initial_schema.js";
import * as slotClaimRlsHardening from "./migrations/0002_slot_claim_rls_hardening.js";
import * as paymentCoreLedger from "./migrations/0003_payment_core_ledger.js";
import * as outboxLeaseHardening from "./migrations/0004_outbox_lease_hardening.js";

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
