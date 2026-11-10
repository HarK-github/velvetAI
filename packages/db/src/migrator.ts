import { Kysely, Migration, MigrationProvider, Migrator } from "kysely";
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
