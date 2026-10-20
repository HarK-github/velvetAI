import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Ensure extensions
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`.execute(db);
  await sql`CREATE EXTENSION IF NOT EXISTS "btree_gist"`.execute(db);

  // 1. Tenants table
  await sql`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      default_currency CHAR(3) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 2. Locations table
  await sql`
    CREATE TABLE IF NOT EXISTS locations (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      name VARCHAR(100) NOT NULL,
      timezone VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_location_tenant_name UNIQUE (tenant_id, name)
    )
  `.execute(db);

  // 3. App Users
  await sql`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      oidc_subject VARCHAR(255) NOT NULL UNIQUE,
      email_ciphertext TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 4. Memberships table
  await sql`
    CREATE TABLE IF NOT EXISTS memberships (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      role VARCHAR(30) NOT NULL,
      role_version INT NOT NULL DEFAULT 1,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_membership_tenant_user UNIQUE (tenant_id, user_id)
    )
  `.execute(db);

  // 5. Customers table
  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      email_ciphertext TEXT NOT NULL,
      display_name_ciphertext TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 6. Services table
  await sql`
    CREATE TABLE IF NOT EXISTS services (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      current_version_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 7. Service Versions table (IMMUTABLE)
  await sql`
    CREATE TABLE IF NOT EXISTS service_versions (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
      version INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      duration_minutes INT NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
      buffer_before_minutes INT NOT NULL DEFAULT 0 CHECK (buffer_before_minutes BETWEEN 0 AND 240),
      buffer_after_minutes INT NOT NULL DEFAULT 0 CHECK (buffer_after_minutes BETWEEN 0 AND 240),
      price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
      base_deposit_minor BIGINT NOT NULL CHECK (base_deposit_minor >= 0),
      currency CHAR(3) NOT NULL,
      cancellation_policy_id UUID NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_deposit_le_price CHECK (base_deposit_minor <= price_minor),
      CONSTRAINT uq_service_version UNIQUE (tenant_id, service_id, version)
    )
  `.execute(db);

  // Add foreign key for services.current_version_id
  await sql`
    ALTER TABLE services
    ADD CONSTRAINT fk_services_current_version
    FOREIGN KEY (current_version_id) REFERENCES service_versions(id)
    ON DELETE SET NULL
  `.execute(db);

  // 8. Resources table
  await sql`
    CREATE TABLE IF NOT EXISTS resources (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      resource_type VARCHAR(30) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // 9. Availability Rules
  await sql`
    CREATE TABLE IF NOT EXISTS availability_rules (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      timezone VARCHAR(50) NOT NULL,
      recurrence_rule TEXT NOT NULL,
      effective_from TIMESTAMPTZ NOT NULL,
      effective_to TIMESTAMPTZ
    )
  `.execute(db);

  // 10. Booking Quotes
  await sql`
    CREATE TABLE IF NOT EXISTS booking_quotes (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      service_version_id UUID NOT NULL REFERENCES service_versions(id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      total_minor BIGINT NOT NULL CHECK (total_minor >= 0),
      deposit_minor BIGINT NOT NULL CHECK (deposit_minor >= 0),
      currency CHAR(3) NOT NULL,
      canonical_hash CHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_quote_times CHECK (starts_at < ends_at),
      CONSTRAINT chk_quote_deposit CHECK (deposit_minor <= total_minor)
    )
  `.execute(db);

  // 11. Bookings
  await sql`
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      customer_id UUID NOT NULL,
      quote_id UUID NOT NULL REFERENCES booking_quotes(id) ON DELETE RESTRICT,
      status VARCHAR(30) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      hold_expires_at TIMESTAMPTZ,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      resource_id UUID REFERENCES resources(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_booking_times CHECK (starts_at < ends_at)
    )
  `.execute(db);

  // 12. Resource Claims with GiST Exclusion Constraint on tstzrange
  await sql`
    CREATE TABLE IF NOT EXISTS resource_claims (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
      blocked_during TSTZRANGE NOT NULL,
      state VARCHAR(20) NOT NULL DEFAULT 'HELD',
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT no_overlapping_claims EXCLUDE USING gist (
        tenant_id WITH =,
        resource_id WITH =,
        blocked_during WITH &&
      ) WHERE (state IN ('ACTIVE', 'HELD'))
    )
  `.execute(db);

  // 13. Idempotency Records
  await sql`
    CREATE TABLE IF NOT EXISTS idempotency_records (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_id UUID NOT NULL,
      operation VARCHAR(100) NOT NULL,
      idempotency_key VARCHAR(255) NOT NULL,
      request_hash CHAR(64) NOT NULL,
      state VARCHAR(20) NOT NULL,
      response_status INT,
      response_body JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT uq_idempotency UNIQUE (tenant_id, actor_id, operation, idempotency_key)
    )
  `.execute(db);

  // 14. Outbox Events
  await sql`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      aggregate_type VARCHAR(50) NOT NULL,
      aggregate_id UUID NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `.execute(db);

  // Indexes for outbox dispatcher polling
  await sql`
    CREATE INDEX IF NOT EXISTS idx_outbox_unprocessed
    ON outbox_events (created_at)
    WHERE processed_at IS NULL AND claimed_at IS NULL
  `.execute(db);

  // 15. Inbox Events (Deduplication)
  await sql`
    CREATE TABLE IF NOT EXISTS inbox_events (
      id UUID PRIMARY KEY,
      consumer_name VARCHAR(100) NOT NULL,
      event_id UUID NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_inbox_consumer_event UNIQUE (consumer_name, event_id)
    )
  `.execute(db);

  // 16. Audit Events (APPEND-ONLY)
  await sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      actor_id UUID,
      actor_type VARCHAR(30) NOT NULL,
      action VARCHAR(100) NOT NULL,
      resource_type VARCHAR(50) NOT NULL,
      resource_id UUID,
      metadata_redacted JSONB NOT NULL DEFAULT '{}',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  // Disallow updates and deletes on audit_events
  await sql`
    CREATE OR REPLACE RULE no_update_audit AS ON UPDATE TO audit_events DO INSTEAD NOTHING;
    CREATE OR REPLACE RULE no_delete_audit AS ON DELETE TO audit_events DO INSTEAD NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS audit_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS inbox_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS outbox_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS idempotency_records CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS resource_claims CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS bookings CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS booking_quotes CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS availability_rules CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS resources CASCADE`.execute(db);
  await sql`ALTER TABLE services DROP CONSTRAINT IF EXISTS fk_services_current_version`.execute(db);
  await sql`DROP TABLE IF EXISTS service_versions CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS services CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS customers CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS memberships CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS app_users CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS locations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS tenants CASCADE`.execute(db);
}
