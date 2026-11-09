import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Table: judge_runs
  await sql`
    CREATE TABLE IF NOT EXISTS judge_runs (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01'::uuid),
      seed_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      requested_by UUID NOT NULL REFERENCES app_users(id),
      steps JSONB NOT NULL DEFAULT '[]'::jsonb,
      summary JSONB
    );
  `.execute(db);

  // 2. Table: demo_schedule_fixtures
  await sql`
    CREATE TABLE IF NOT EXISTS demo_schedule_fixtures (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01'::uuid),
      judge_run_id UUID NOT NULL REFERENCES judge_runs(id) ON DELETE CASCADE,
      resource_id UUID NOT NULL,
      service_id UUID NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      display_status TEXT NOT NULL CHECK (display_status IN ('CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
      buyer_key TEXT NOT NULL,
      deposit_paid BOOLEAN NOT NULL,
      claim_id UUID NULL REFERENCES resource_claims(id) ON DELETE SET NULL,
      CONSTRAINT fk_fixtures_tenant_resource FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_fixtures_tenant_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE
    );
  `.execute(db);

  // 3. Table: synthetic_history
  await sql`
    CREATE TABLE IF NOT EXISTS synthetic_history (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL CHECK (tenant_id = '01932b10-0000-7000-8000-000000000a01'::uuid),
      judge_run_id UUID NOT NULL REFERENCES judge_runs(id) ON DELETE CASCADE,
      resource_id UUID NOT NULL,
      service_id UUID NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('ATTENDED', 'NO_SHOW', 'CANCELLED_LATE', 'CANCELLED_EARLY')),
      lead_time_hours INTEGER NOT NULL CHECK (lead_time_hours >= 0),
      deposit_paid BOOLEAN NOT NULL,
      buyer_key TEXT NOT NULL,
      CONSTRAINT fk_history_tenant_resource FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT fk_history_tenant_service FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id) ON DELETE CASCADE
    );
  `.execute(db);

  // 4. Update resource_claims to allow DEMO_FIXTURE claims without booking_id in judge tenant
  await sql`
    ALTER TABLE resource_claims
    ADD COLUMN IF NOT EXISTS claim_source TEXT NOT NULL DEFAULT 'BOOKING'
    CHECK (claim_source IN ('BOOKING', 'DEMO_FIXTURE'));
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ALTER COLUMN booking_id DROP NOT NULL;
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT chk_resource_claim_source_booking_binding
    CHECK (
      (claim_source = 'BOOKING' AND booking_id IS NOT NULL)
      OR
      (claim_source = 'DEMO_FIXTURE' AND booking_id IS NULL AND tenant_id = '01932b10-0000-7000-8000-000000000a01'::uuid)
    );
  `.execute(db);

  // 5. Indexes for schedule lookups and run tracking
  await sql`
    CREATE INDEX IF NOT EXISTS idx_judge_runs_tenant_started
    ON judge_runs (tenant_id, started_at DESC);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_demo_schedule_fixtures_calendar
    ON demo_schedule_fixtures (tenant_id, resource_id, starts_at);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_synthetic_history_calendar
    ON synthetic_history (tenant_id, resource_id, starts_at);
  `.execute(db);

  // 6. Enable and Force Row Level Security on all 3 new tenant tables
  const newTenantTables = ["judge_runs", "demo_schedule_fixtures", "synthetic_history"] as const;

  for (const table of newTenantTables) {
    await sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`).execute(db);
    await sql
      .raw(
        `
      CREATE POLICY tenant_isolation_policy ON ${table}
      FOR ALL
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    `,
      )
      .execute(db);
  }

  // 7. Schema and sequence permissions for velvet_runtime
  await sql`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
        GRANT ALL PRIVILEGES ON judge_runs TO velvet_runtime;
        GRANT ALL PRIVILEGES ON demo_schedule_fixtures TO velvet_runtime;
        GRANT ALL PRIVILEGES ON synthetic_history TO velvet_runtime;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO velvet_runtime;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO velvet_runtime;
      END IF;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop RLS policies
  const tables = ["synthetic_history", "demo_schedule_fixtures", "judge_runs"] as const;
  for (const table of tables) {
    await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table};`).execute(db);
    await sql.raw(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`DROP TABLE IF EXISTS ${table} CASCADE;`).execute(db);
  }

  // Restore resource_claims constraints
  await sql`
    ALTER TABLE resource_claims
    DROP CONSTRAINT IF EXISTS chk_resource_claim_source_booking_binding;
  `.execute(db);

  // Clean up any demo fixture claims before restoring NOT NULL
  await sql`
    DELETE FROM resource_claims WHERE booking_id IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    DROP COLUMN IF EXISTS claim_source;
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ALTER COLUMN booking_id SET NOT NULL;
  `.execute(db);
}
