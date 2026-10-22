import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE outbox_events
    ADD COLUMN IF NOT EXISTS lease_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_outbox_lease_claim
    ON outbox_events (created_at)
    WHERE processed_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_outbox_lease_claim;`.execute(db);
  await sql`
    ALTER TABLE outbox_events
    DROP COLUMN IF EXISTS lease_token,
    DROP COLUMN IF EXISTS lease_expires_at;
  `.execute(db);
}
