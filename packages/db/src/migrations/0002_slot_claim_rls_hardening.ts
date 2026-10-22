import { Kysely, sql } from "kysely";

const TENANT_TABLES = [
  "locations",
  "customers",
  "memberships",
  "services",
  "service_versions",
  "resources",
  "availability_rules",
  "booking_quotes",
  "bookings",
  "resource_claims",
  "booking_hold_snapshots",
  "buyer_confirmations",
  "committed_intents",
  "idempotency_records",
  "outbox_events",
  "audit_events",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Booking Hold Snapshots table
  await sql`
    CREATE TABLE IF NOT EXISTS booking_hold_snapshots (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      service_version_id UUID NOT NULL,
      resource_id UUID NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      total_minor BIGINT NOT NULL,
      deposit_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      currency_scale INT NOT NULL DEFAULT 2,
      cancellation_policy_id UUID NOT NULL,
      cancellation_policy_version INT NOT NULL,
      cancellation_policy_hash CHAR(64) NOT NULL,
      merchant_id UUID NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      actor_id UUID NOT NULL,
      canonical_hash CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_hold_snapshot_booking UNIQUE (tenant_id, booking_id)
    )
  `.execute(db);

  // 2. Buyer Confirmations table
  await sql`
    CREATE TABLE IF NOT EXISTS buyer_confirmations (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      confirmation_jti VARCHAR(255) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      buyer_user_id UUID NOT NULL,
      interaction_locator VARCHAR(255) NOT NULL,
      consumed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_tenant_confirmation_jti UNIQUE (tenant_id, confirmation_jti),
      CONSTRAINT uq_buyer_confirmation_locator UNIQUE (tenant_id, interaction_locator)
    )
  `.execute(db);

  // 3. Committed Intents table (for replay prevention and uniqueness per tenant)
  await sql`
    CREATE TABLE IF NOT EXISTS committed_intents (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      intent_jti VARCHAR(255) NOT NULL,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_tenant_intent_jti UNIQUE (tenant_id, intent_jti)
    )
  `.execute(db);

  // 4. Update idempotency_records to support client_id and composite uniqueness (tenant_id, client_id, idempotency_key)
  await sql`
    ALTER TABLE idempotency_records
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(255) NOT NULL DEFAULT 'default-client';
  `.execute(db);

  await sql`
    ALTER TABLE idempotency_records
    DROP CONSTRAINT IF EXISTS uq_idempotency;
  `.execute(db);

  await sql`
    ALTER TABLE idempotency_records
    DROP CONSTRAINT IF EXISTS uq_tenant_client_idempotency;
  `.execute(db);

  await sql`
    ALTER TABLE idempotency_records
    ADD CONSTRAINT uq_tenant_client_idempotency UNIQUE (tenant_id, client_id, idempotency_key);
  `.execute(db);

  // 5. Update resource_claims with persisted blocking state, starts_at, ends_at, and hold_expires_at
  await sql`
    ALTER TABLE resource_claims
    ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS blocking BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
  `.execute(db);

  // Sync existing rows if any
  await sql`
    UPDATE resource_claims
    SET starts_at = lower(blocked_during),
        ends_at = upper(blocked_during),
        blocking = (state IN ('HELD', 'COMMITTING', 'CAPTURE_UNCERTAIN', 'CONFIRMED')),
        hold_expires_at = COALESCE(expires_at, NOW() + INTERVAL '15 minutes')
    WHERE starts_at IS NULL OR blocking != (state IN ('HELD', 'COMMITTING', 'CAPTURE_UNCERTAIN', 'CONFIRMED'));
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ALTER COLUMN starts_at SET NOT NULL,
    ALTER COLUMN ends_at SET NOT NULL;
  `.execute(db);

  // Drop old exclusion constraint
  await sql`
    ALTER TABLE resource_claims
    DROP CONSTRAINT IF EXISTS no_overlapping_claims;
  `.execute(db);

  // Create new authoritative GiST exclusion constraint on (tenant_id, resource_id, blocked_during) WHERE (blocking)
  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT no_overlapping_claims EXCLUDE USING gist (
      tenant_id WITH =,
      resource_id WITH =,
      blocked_during WITH &&
    ) WHERE (blocking);
  `.execute(db);

  // Authoritative CHECK constraint proving blocking state integrity per Acceptance Audit Requirement 2
  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT chk_resource_claim_blocking_state
    CHECK (
      blocking = (
        state IN ('HELD', 'COMMITTING', 'CAPTURE_UNCERTAIN', 'CONFIRMED')
      )
    );
  `.execute(db);

  // Supporting indexes for calendar lookups and expiry worker
  await sql`
    CREATE INDEX IF NOT EXISTS resource_claim_calendar_idx
    ON resource_claims (tenant_id, resource_id, starts_at)
    INCLUDE (ends_at, state, hold_expires_at);
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS resource_claim_expiry_idx
    ON resource_claims (hold_expires_at, id)
    INCLUDE (tenant_id)
    WHERE state = 'HELD';
  `.execute(db);

  // 6. Composite Unique Constraints to support composite foreign keys
  await sql`ALTER TABLE locations ADD CONSTRAINT uq_locations_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );
  await sql`ALTER TABLE services ADD CONSTRAINT uq_services_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );
  await sql`ALTER TABLE service_versions ADD CONSTRAINT uq_service_versions_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );
  await sql`ALTER TABLE resources ADD CONSTRAINT uq_resources_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );
  await sql`ALTER TABLE booking_quotes ADD CONSTRAINT uq_booking_quotes_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );
  await sql`ALTER TABLE bookings ADD CONSTRAINT uq_bookings_tenant_id UNIQUE (tenant_id, id);`.execute(
    db,
  );

  // 7. Composite Foreign Keys
  await sql`
    ALTER TABLE bookings
    ADD CONSTRAINT fk_bookings_tenant_quote
    FOREIGN KEY (tenant_id, quote_id) REFERENCES booking_quotes(tenant_id, id)
    ON DELETE RESTRICT;
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT fk_claims_tenant_booking
    FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id)
    ON DELETE CASCADE;
  `.execute(db);

  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT fk_claims_tenant_resource
    FOREIGN KEY (tenant_id, resource_id) REFERENCES resources(tenant_id, id)
    ON DELETE RESTRICT;
  `.execute(db);

  await sql`
    ALTER TABLE buyer_confirmations
    ADD CONSTRAINT fk_confirmations_tenant_booking
    FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id)
    ON DELETE CASCADE;
  `.execute(db);

  await sql`
    ALTER TABLE booking_hold_snapshots
    ADD CONSTRAINT fk_snapshots_tenant_booking
    FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id)
    ON DELETE CASCADE;
  `.execute(db);

  await sql`
    ALTER TABLE committed_intents
    ADD CONSTRAINT fk_intents_tenant_booking
    FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id)
    ON DELETE CASCADE;
  `.execute(db);

  // 8. Row Level Security: Enable and force RLS on all tenant-owned tables
  for (const table of TENANT_TABLES) {
    await sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table};`).execute(db);
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

  // 9. Create runtime database role (NOBYPASSRLS is default in PostgreSQL)
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
        CREATE ROLE velvet_runtime NOLOGIN NOBYPASSRLS;
      END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'velvet') THEN
        GRANT velvet_runtime TO velvet WITH INHERIT TRUE, SET TRUE;
      END IF;
    END $$;
  `.execute(db);

  await sql`GRANT USAGE ON SCHEMA public TO velvet_runtime;`.execute(db);
  await sql`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO velvet_runtime;`.execute(db);
  await sql`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO velvet_runtime;`.execute(db);
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO velvet_runtime;`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Disable RLS
  for (const table of TENANT_TABLES) {
    await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table};`).execute(db);
    await sql.raw(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`).execute(db);
    await sql.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).execute(db);
  }

  // Drop composite FKs
  await sql`ALTER TABLE committed_intents DROP CONSTRAINT IF EXISTS fk_intents_tenant_booking;`.execute(
    db,
  );
  await sql`ALTER TABLE booking_hold_snapshots DROP CONSTRAINT IF EXISTS fk_snapshots_tenant_booking;`.execute(
    db,
  );
  await sql`ALTER TABLE buyer_confirmations DROP CONSTRAINT IF EXISTS fk_confirmations_tenant_booking;`.execute(
    db,
  );
  await sql`ALTER TABLE resource_claims DROP CONSTRAINT IF EXISTS fk_claims_tenant_resource;`.execute(
    db,
  );
  await sql`ALTER TABLE resource_claims DROP CONSTRAINT IF EXISTS fk_claims_tenant_booking;`.execute(
    db,
  );
  await sql`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS fk_bookings_tenant_quote;`.execute(db);

  // Drop composite UQs
  await sql`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS uq_bookings_tenant_id;`.execute(db);
  await sql`ALTER TABLE booking_quotes DROP CONSTRAINT IF EXISTS uq_booking_quotes_tenant_id;`.execute(
    db,
  );
  await sql`ALTER TABLE resources DROP CONSTRAINT IF EXISTS uq_resources_tenant_id;`.execute(db);
  await sql`ALTER TABLE service_versions DROP CONSTRAINT IF EXISTS uq_service_versions_tenant_id;`.execute(
    db,
  );
  await sql`ALTER TABLE services DROP CONSTRAINT IF EXISTS uq_services_tenant_id;`.execute(db);
  await sql`ALTER TABLE locations DROP CONSTRAINT IF EXISTS uq_locations_tenant_id;`.execute(db);

  // Drop indexes
  await sql`DROP INDEX IF EXISTS resource_claim_expiry_idx;`.execute(db);
  await sql`DROP INDEX IF EXISTS resource_claim_calendar_idx;`.execute(db);

  // Restore old exclusion constraint
  await sql`ALTER TABLE resource_claims DROP CONSTRAINT IF EXISTS chk_resource_claim_blocking_state;`.execute(
    db,
  );
  await sql`ALTER TABLE resource_claims DROP CONSTRAINT IF EXISTS no_overlapping_claims;`.execute(
    db,
  );
  await sql`
    ALTER TABLE resource_claims
    ADD CONSTRAINT no_overlapping_claims EXCLUDE USING gist (
      tenant_id WITH =,
      resource_id WITH =,
      blocked_during WITH &&
    ) WHERE (state IN ('ACTIVE', 'HELD'));
  `.execute(db);

  // Drop columns
  await sql`
    ALTER TABLE resource_claims
    DROP COLUMN IF EXISTS hold_expires_at,
    DROP COLUMN IF EXISTS blocking,
    DROP COLUMN IF EXISTS ends_at,
    DROP COLUMN IF EXISTS starts_at;
  `.execute(db);

  // Restore idempotency uniqueness
  await sql`ALTER TABLE idempotency_records DROP CONSTRAINT IF EXISTS uq_tenant_client_idempotency;`.execute(
    db,
  );
  await sql`
    ALTER TABLE idempotency_records
    ADD CONSTRAINT uq_idempotency UNIQUE (tenant_id, actor_id, operation, idempotency_key);
  `.execute(db);
  await sql`ALTER TABLE idempotency_records DROP COLUMN IF EXISTS client_id;`.execute(db);

  // Drop new tables
  await sql`DROP TABLE IF EXISTS committed_intents CASCADE;`.execute(db);
  await sql`DROP TABLE IF EXISTS buyer_confirmations CASCADE;`.execute(db);
  await sql`DROP TABLE IF EXISTS booking_hold_snapshots CASCADE;`.execute(db);
}
