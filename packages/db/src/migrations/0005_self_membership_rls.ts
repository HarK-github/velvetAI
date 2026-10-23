import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Add memberships SELECT-only RLS policy allowing authenticated local user to read their own rows
  await sql`DROP POLICY IF EXISTS self_membership_select_policy ON memberships;`.execute(db);
  await sql`
    CREATE POLICY self_membership_select_policy ON memberships
    FOR SELECT
    USING (
      user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    );
  `.execute(db);

  // 2. Add index on memberships(user_id) for efficient self-membership lookups
  await sql`
    CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP POLICY IF EXISTS self_membership_select_policy ON memberships;`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_memberships_user_id;`.execute(db);
}
