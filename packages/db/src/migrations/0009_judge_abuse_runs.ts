import { Kysely, sql } from "kysely";

const JUDGE_TENANT_ID = "01932b10-0000-7000-8000-000000000a01";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS judge_abuse_runs (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      requested_by TEXT NOT NULL,
      scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary JSONB,
      CONSTRAINT chk_judge_abuse_runs_judge_tenant
        CHECK (tenant_id = ${sql.lit(JUDGE_TENANT_ID)}::uuid),
      CONSTRAINT chk_judge_abuse_runs_status
        CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_judge_abuse_runs_tenant_started
      ON judge_abuse_runs (tenant_id, started_at DESC)
  `.execute(db);

  await sql.raw(`ALTER TABLE judge_abuse_runs ENABLE ROW LEVEL SECURITY;`).execute(db);
  await sql.raw(`ALTER TABLE judge_abuse_runs FORCE ROW LEVEL SECURITY;`).execute(db);
  await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON judge_abuse_runs;`).execute(db);
  await sql
    .raw(
      `
      CREATE POLICY tenant_isolation_policy ON judge_abuse_runs
      FOR ALL
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    `,
    )
    .execute(db);

  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE judge_abuse_runs TO velvet_runtime;
      END IF;
    END
    $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON judge_abuse_runs;`).execute(db);
  await sql`DROP TABLE IF EXISTS judge_abuse_runs CASCADE;`.execute(db);
}
