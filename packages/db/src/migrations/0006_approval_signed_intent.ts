import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Allow buyer_user_id to be NULL for M2M agent holds until claimed by human buyer
  await sql`
    ALTER TABLE buyer_confirmations
    ALTER COLUMN buyer_user_id DROP NOT NULL;
  `.execute(db);

  // 2. Add signed_intent, signed_intent_hash, and prepared_by_surface columns
  await sql`
    ALTER TABLE buyer_confirmations
    ADD COLUMN IF NOT EXISTS signed_intent TEXT,
    ADD COLUMN IF NOT EXISTS signed_intent_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS prepared_by_surface VARCHAR(32) DEFAULT 'web';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE buyer_confirmations
    DROP COLUMN IF EXISTS signed_intent,
    DROP COLUMN IF EXISTS signed_intent_hash,
    DROP COLUMN IF EXISTS prepared_by_surface;
  `.execute(db);

  await sql`
    UPDATE buyer_confirmations
    SET buyer_user_id = '00000000-0000-0000-0000-000000000000'
    WHERE buyer_user_id IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE buyer_confirmations
    ALTER COLUMN buyer_user_id SET NOT NULL;
  `.execute(db);
}
