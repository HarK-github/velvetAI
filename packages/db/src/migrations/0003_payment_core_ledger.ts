import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. provider_connections table
  await sql`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL DEFAULT 'PAYPAL',
      environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
      connection_key VARCHAR(100) NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      client_secret_ciphertext TEXT NOT NULL,
      webhook_id VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_provider_conn_tenant_key UNIQUE (tenant_id, connection_key),
      CONSTRAINT uq_provider_conn_env_key UNIQUE (environment, connection_key)
    )
  `.execute(db);

  // 2. Add payment_expires_at to bookings
  await sql`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ
  `.execute(db);

  // 3. provider_operations table (Provider Mutation Journal)
  await sql`
    CREATE TABLE IF NOT EXISTS provider_operations (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider VARCHAR(50) NOT NULL DEFAULT 'PAYPAL',
      environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
      operation_type VARCHAR(50) NOT NULL,
      state VARCHAR(30) NOT NULL,
      endpoint VARCHAR(255) NOT NULL,
      paypal_request_id VARCHAR(255) NOT NULL,
      canonical_payload_hash CHAR(64) NOT NULL,
      provider_order_id VARCHAR(255),
      provider_capture_id VARCHAR(255),
      provider_refund_id VARCHAR(255),
      attempt_count INT NOT NULL DEFAULT 0,
      first_dispatched_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      next_reconcile_at TIMESTAMPTZ,
      last_http_status INT,
      provider_debug_id VARCHAR(255),
      error_code VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_provider_op_tenant_req_type UNIQUE (tenant_id, paypal_request_id, operation_type),
      CONSTRAINT chk_provider_op_state CHECK (
        state IN (
          'PREPARED',
          'DISPATCHING',
          'SENT_UNKNOWN',
          'PENDING',
          'SUCCEEDED',
          'FAILED_TERMINAL',
          'RECONCILING',
          'MANUAL_REVIEW'
        )
      )
    )
  `.execute(db);

  // Uniqueness indexes for provider resources when present
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_op_order
    ON provider_operations (provider, provider_order_id)
    WHERE operation_type = 'ORDER_CREATE' AND provider_order_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_op_capture
    ON provider_operations (provider, provider_capture_id)
    WHERE operation_type = 'CAPTURE' AND provider_capture_id IS NOT NULL
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_op_refund
    ON provider_operations (provider, provider_refund_id)
    WHERE operation_type = 'REFUND' AND provider_refund_id IS NOT NULL
  `.execute(db);

  // Reconcile index for background recovery
  await sql`
    CREATE INDEX IF NOT EXISTS idx_provider_operations_reconcile
    ON provider_operations (next_reconcile_at)
    WHERE state IN ('SENT_UNKNOWN', 'PENDING', 'RECONCILING')
  `.execute(db);

  // 4. payment_intents table
  await sql`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
      provider_order_id VARCHAR(255),
      amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      state VARCHAR(30) NOT NULL DEFAULT 'ORDER_CREATE_PENDING',
      payment_expires_at TIMESTAMPTZ NOT NULL,
      request_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_payment_intent_booking UNIQUE (tenant_id, booking_id),
      CONSTRAINT chk_payment_intent_state CHECK (
        state IN (
          'ORDER_CREATE_PENDING',
          'ORDER_CREATE_UNKNOWN',
          'REQUIRES_PAYER_ACTION',
          'PAYMENT_WINDOW_EXPIRED',
          'CAPTURE_IN_FLIGHT',
          'CAPTURE_UNCERTAIN',
          'CAPTURED',
          'PAYMENT_FAILED',
          'MANUAL_REVIEW'
        )
      )
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intent_provider_order
    ON payment_intents (tenant_id, provider_order_id)
    WHERE provider_order_id IS NOT NULL
  `.execute(db);

  // 5. payment_captures table
  await sql`
    CREATE TABLE IF NOT EXISTS payment_captures (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      payment_intent_id UUID NOT NULL REFERENCES payment_intents(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider_capture_id VARCHAR(255) NOT NULL,
      amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      state VARCHAR(30) NOT NULL,
      captured_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_payment_capture_provider_id UNIQUE (tenant_id, provider_capture_id),
      CONSTRAINT chk_payment_capture_state CHECK (
        state IN (
          'COMPLETED',
          'PENDING',
          'DECLINED',
          'FAILED',
          'PARTIALLY_REFUNDED',
          'REFUNDED'
        )
      )
    )
  `.execute(db);

  // 6. refund_reservations table
  await sql`
    CREATE TABLE IF NOT EXISTS refund_reservations (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      capture_id UUID NOT NULL REFERENCES payment_captures(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider_refund_id VARCHAR(255),
      amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      reason VARCHAR(100) NOT NULL,
      state VARCHAR(30) NOT NULL DEFAULT 'RESERVED',
      request_id VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_refund_reservation_req UNIQUE (tenant_id, request_id),
      CONSTRAINT chk_refund_reservation_state CHECK (
        state IN (
          'RESERVED',
          'DISPATCHING',
          'COMPLETED',
          'FAILED',
          'UNKNOWN'
        )
      )
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_provider_id
    ON refund_reservations (tenant_id, provider_refund_id)
    WHERE provider_refund_id IS NOT NULL
  `.execute(db);

  // 7. webhook_deliveries table (Raw Quarantine Inbox - Ingress Boundary)
  await sql`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY,
      connection_key VARCHAR(100) NOT NULL,
      environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
      transmission_id VARCHAR(255) NOT NULL,
      transmission_time VARCHAR(100) NOT NULL,
      cert_url TEXT NOT NULL,
      auth_algo VARCHAR(100) NOT NULL,
      transmission_sig TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      body_bytes_length INT NOT NULL,
      verification_state VARCHAR(30) NOT NULL DEFAULT 'UNVERIFIED',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_webhook_payload_length CHECK (body_bytes_length <= 262144),
      CONSTRAINT chk_webhook_delivery_state CHECK (
        verification_state IN ('UNVERIFIED', 'VERIFIED', 'FAILED_VERIFICATION')
      )
    )
  `.execute(db);

  // 8. verified_provider_events table (Post-Verification Deduplicated Events)
  await sql`
    CREATE TABLE IF NOT EXISTS verified_provider_events (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
      environment VARCHAR(20) NOT NULL DEFAULT 'sandbox',
      provider_event_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(100) NOT NULL,
      transmission_id VARCHAR(255) NOT NULL,
      resource_id VARCHAR(255),
      resource_type VARCHAR(50),
      reconciliation_state VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_verified_event UNIQUE (environment, provider_connection_id, provider_event_id),
      CONSTRAINT chk_verified_event_recon CHECK (
        reconciliation_state IN ('PENDING', 'PROCESSED', 'IGNORED_OUT_OF_ORDER', 'FAILED')
      )
    )
  `.execute(db);

  // 9. financial_journal_entries table (Append-Only)
  await sql`
    CREATE TABLE IF NOT EXISTS financial_journal_entries (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      entry_type VARCHAR(50) NOT NULL,
      reference_id VARCHAR(255) NOT NULL,
      currency CHAR(3) NOT NULL,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.execute(db);

  await sql`
    CREATE OR REPLACE RULE no_update_journal_entries AS ON UPDATE TO financial_journal_entries DO INSTEAD NOTHING;
    CREATE OR REPLACE RULE no_delete_journal_entries AS ON DELETE TO financial_journal_entries DO INSTEAD NOTHING;
  `.execute(db);

  // 10. financial_journal_lines table (Append-Only Double-Entry Balancing Lines)
  await sql`
    CREATE TABLE IF NOT EXISTS financial_journal_lines (
      id UUID PRIMARY KEY,
      journal_entry_id UUID NOT NULL REFERENCES financial_journal_entries(id) ON DELETE RESTRICT,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      account VARCHAR(50) NOT NULL,
      debit_minor BIGINT NOT NULL DEFAULT 0,
      credit_minor BIGINT NOT NULL DEFAULT 0,
      currency CHAR(3) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_line_debit_credit CHECK (
        (debit_minor > 0 AND credit_minor = 0) OR
        (credit_minor > 0 AND debit_minor = 0)
      )
    )
  `.execute(db);

  await sql`
    CREATE OR REPLACE RULE no_update_journal_lines AS ON UPDATE TO financial_journal_lines DO INSTEAD NOTHING;
    CREATE OR REPLACE RULE no_delete_journal_lines AS ON DELETE TO financial_journal_lines DO INSTEAD NOTHING;
  `.execute(db);

  // 11. invoices table (Customer-facing balance projection)
  await sql`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
      provider_invoice_id VARCHAR(255),
      provider_invoice_number VARCHAR(100),
      status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
      total_minor BIGINT NOT NULL,
      deposit_paid_minor BIGINT NOT NULL,
      balance_due_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_invoice_status CHECK (
        status IN ('DRAFT', 'SENT', 'PAID', 'CANCELLED', 'REFUNDED')
      )
    )
  `.execute(db);

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_provider_id
    ON invoices (tenant_id, provider_invoice_id)
    WHERE provider_invoice_id IS NOT NULL
  `.execute(db);

  // Enable and FORCE Row-Level Security on all tenant-owned tables
  const tenantTables = [
    "provider_connections",
    "provider_operations",
    "payment_intents",
    "payment_captures",
    "refund_reservations",
    "verified_provider_events",
    "financial_journal_entries",
    "financial_journal_lines",
    "invoices",
  ];

  for (const table of tenantTables) {
    await sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`).execute(db);
    await sql.raw(`
      CREATE POLICY tenant_isolation_policy ON ${table}
      FOR ALL
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
    `).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const tenantTables = [
    "invoices",
    "financial_journal_lines",
    "financial_journal_entries",
    "verified_provider_events",
    "refund_reservations",
    "payment_captures",
    "payment_intents",
    "provider_operations",
    "provider_connections",
  ];

  for (const table of tenantTables) {
    await sql.raw(`DROP POLICY IF EXISTS tenant_isolation_policy ON ${table}`).execute(db);
  }

  await sql`DROP RULE IF EXISTS no_update_journal_lines ON financial_journal_lines`.execute(db);
  await sql`DROP RULE IF EXISTS no_delete_journal_lines ON financial_journal_lines`.execute(db);
  await sql`DROP TABLE IF EXISTS financial_journal_lines CASCADE`.execute(db);

  await sql`DROP RULE IF EXISTS no_update_journal_entries ON financial_journal_entries`.execute(db);
  await sql`DROP RULE IF EXISTS no_delete_journal_entries ON financial_journal_entries`.execute(db);
  await sql`DROP TABLE IF EXISTS financial_journal_entries CASCADE`.execute(db);

  await sql`DROP TABLE IF EXISTS invoices CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS verified_provider_events CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS webhook_deliveries CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS refund_reservations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS payment_captures CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS payment_intents CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS provider_operations CASCADE`.execute(db);
  await sql`DROP TABLE IF EXISTS provider_connections CASCADE`.execute(db);

  await sql`
    ALTER TABLE bookings
    DROP COLUMN IF EXISTS payment_expires_at
  `.execute(db);
}
