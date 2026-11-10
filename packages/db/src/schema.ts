import { ColumnType, Generated } from "kysely";

export interface Database {
  tenants: TenantTable;
  locations: LocationTable;
  app_users: AppUserTable;
  memberships: MembershipTable;
  customers: CustomerTable;
  services: ServiceTable;
  service_versions: ServiceVersionTable;
  resources: ResourceTable;
  availability_rules: AvailabilityRuleTable;
  booking_quotes: BookingQuoteTable;
  bookings: BookingTable;
  resource_claims: ResourceClaimTable;
  booking_hold_snapshots: BookingHoldSnapshotTable;
  buyer_confirmations: BuyerConfirmationTable;
  committed_intents: CommittedIntentTable;
  provider_connections: ProviderConnectionTable;
  provider_operations: ProviderOperationTable;
  payment_intents: PaymentIntentTable;
  payment_captures: PaymentCaptureTable;
  refund_reservations: RefundReservationTable;
  webhook_quarantine: WebhookQuarantineTable;
  webhook_deliveries: WebhookQuarantineTable;
  verified_provider_events: VerifiedProviderEventTable;
  financial_journal_entries: FinancialJournalEntryTable;
  financial_journal_lines: FinancialJournalLineTable;
  invoices: InvoiceTable;
  idempotency_records: IdempotencyRecordTable;
  outbox_events: OutboxEventTable;
  inbox_events: InboxEventTable;
  audit_events: AuditEventTable;
  judge_runs: JudgeRunTable;
  demo_schedule_fixtures: DemoScheduleFixtureTable;
  synthetic_history: SyntheticHistoryTable;
}

export interface TenantTable {
  id: string;
  name: string;
  default_currency: string;
  status: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface LocationTable {
  id: string;
  tenant_id: string;
  name: string;
  timezone: string;
  status: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface AppUserTable {
  id: string;
  oidc_subject: string;
  email_ciphertext: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface MembershipTable {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
  role_version: number;
  revoked_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface CustomerTable {
  id: string;
  tenant_id: string;
  email_ciphertext: string;
  display_name_ciphertext: string | null;
  status: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ServiceTable {
  id: string;
  tenant_id: string;
  status: string;
  current_version_id: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ServiceVersionTable {
  id: string;
  tenant_id: string;
  service_id: string;
  version: number;
  name: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  price_minor: string; // stored as bigint in PG
  base_deposit_minor: string; // stored as bigint in PG
  currency: string;
  cancellation_policy_id: string;
  published_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ResourceTable {
  id: string;
  tenant_id: string;
  location_id: string;
  resource_type: string;
  display_name: string;
  status: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface AvailabilityRuleTable {
  id: string;
  tenant_id: string;
  resource_id: string;
  timezone: string;
  recurrence_rule: string;
  effective_from: ColumnType<Date, string | Date, never>;
  effective_to: ColumnType<Date | null, string | Date | null, string | Date | null>;
}

export interface BookingQuoteTable {
  id: string;
  tenant_id: string;
  service_version_id: string;
  customer_id: string;
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  total_minor: string;
  deposit_minor: string;
  currency: string;
  canonical_hash: string;
  expires_at: ColumnType<Date, string | Date, never>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface BookingTable {
  id: string;
  tenant_id: string;
  customer_id: string;
  quote_id: string;
  status: string;
  version: number;
  hold_expires_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  payment_expires_at: ColumnType<
    Date | null,
    string | Date | null | undefined,
    string | Date | null
  >;
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  resource_id: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ResourceClaimTable {
  id: string;
  tenant_id: string;
  booking_id: string | null;
  claim_source: ColumnType<string, string | undefined, never>;
  resource_id: string;
  blocked_during: unknown; // tstzrange in PostgreSQL
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  blocking: boolean;
  state: string;
  hold_expires_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  expires_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface BookingHoldSnapshotTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  service_version_id: string;
  resource_id: string;
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  total_minor: string;
  deposit_minor: string;
  currency: string;
  currency_scale: number;
  cancellation_policy_id: string;
  cancellation_policy_version: number;
  cancellation_policy_hash: string;
  merchant_id: string;
  client_id: string;
  actor_id: string;
  canonical_hash: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface BuyerConfirmationTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  confirmation_jti: string;
  token_hash: string;
  buyer_user_id: string | null;
  interaction_locator: string;
  signed_intent: string | null;
  signed_intent_hash: string | null;
  prepared_by_surface: string | null;
  consumed_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  expires_at: ColumnType<Date, string | Date, never>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface CommittedIntentTable {
  id: string;
  tenant_id: string;
  intent_jti: string;
  booking_id: string;
  committed_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ProviderConnectionTable {
  id: string;
  tenant_id: string;
  provider: string;
  environment: string;
  connection_key: string;
  client_id: string;
  client_secret_ciphertext: string;
  webhook_id: string | null;
  status: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface ProviderOperationTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider: string;
  environment: string;
  operation_type: string;
  state: string;
  endpoint: string;
  paypal_request_id: string;
  canonical_payload_hash: string;
  provider_order_id: string | null;
  provider_capture_id: string | null;
  provider_refund_id: string | null;
  attempt_count: ColumnType<number, number | undefined, number>;
  first_dispatched_at: ColumnType<
    Date | null,
    string | Date | null | undefined,
    string | Date | null
  >;
  last_attempt_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  next_reconcile_at: ColumnType<
    Date | null,
    string | Date | null | undefined,
    string | Date | null
  >;
  last_http_status: number | null;
  provider_debug_id: string | null;
  error_code: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface PaymentIntentTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider_connection_id: string | null;
  provider_order_id: string | null;
  amount_minor: string;
  currency: string;
  state: string;
  payment_expires_at: ColumnType<Date, string | Date, string | Date>;
  request_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface PaymentCaptureTable {
  id: string;
  tenant_id: string;
  payment_intent_id: string;
  booking_id: string;
  provider_capture_id: string;
  amount_minor: string;
  currency: string;
  state: string;
  captured_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface RefundReservationTable {
  id: string;
  tenant_id: string;
  capture_id: string;
  booking_id: string;
  provider_refund_id: string | null;
  amount_minor: string;
  currency: string;
  reason: string;
  state: string;
  request_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface WebhookQuarantineTable {
  id: string;
  connection_key: string;
  environment: string;
  transmission_id: string;
  transmission_time: string;
  cert_url: string;
  auth_algo: string;
  transmission_sig: string;
  raw_payload: string;
  payload_sha256: string;
  body_bytes_length: number;
  verification_state: string;
  received_at: ColumnType<Date, string | Date | undefined, never>;
}

export type WebhookDeliveryTable = WebhookQuarantineTable;

export interface VerifiedProviderEventTable {
  id: string;
  tenant_id: string;
  provider_connection_id: string | null;
  environment: string;
  provider_event_id: string;
  event_type: string;
  transmission_id: string;
  resource_id: string | null;
  resource_type: string | null;
  reconciliation_state: string;
  verified_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface FinancialJournalEntryTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  entry_type: string;
  reference_id: string;
  currency: string;
  status: string;
  posted_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface FinancialJournalLineTable {
  id: string;
  journal_entry_id: string;
  tenant_id: string;
  account: string;
  debit_minor: string;
  credit_minor: string;
  currency: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface InvoiceTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider_invoice_id: string | null;
  provider_invoice_number: string | null;
  status: string;
  total_minor: string;
  deposit_paid_minor: string;
  balance_due_minor: string;
  currency: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface IdempotencyRecordTable {
  id: string;
  tenant_id: string;
  actor_id: string;
  client_id: string;
  operation: string;
  idempotency_key: string;
  request_hash: string;
  state: string;
  response_status: number | null;
  response_body: unknown | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  expires_at: ColumnType<Date, string | Date, never>;
}

export interface OutboxEventTable {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: ColumnType<Date, string | Date | undefined, never>;
  claimed_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  lease_token: string | null;
  lease_expires_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  processed_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface InboxEventTable {
  id: string;
  consumer_name: string;
  event_id: string;
  processed_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface AuditEventTable {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_redacted: unknown;
  occurred_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface JudgeRunTable {
  id: string;
  tenant_id: string;
  seed_version: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | string;
  started_at: ColumnType<Date, string | Date | undefined, never>;
  finished_at: ColumnType<Date | null, string | Date | null | undefined, string | Date | null>;
  requested_by: string;
  steps: ColumnType<unknown, string | unknown | undefined, unknown>;
  summary: ColumnType<unknown | null, string | unknown | null | undefined, unknown | null>;
}

export interface DemoScheduleFixtureTable {
  id: string;
  tenant_id: string;
  judge_run_id: string;
  resource_id: string;
  service_id: string;
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  display_status: "CONFIRMED" | "CHECKED_IN" | "COMPLETED" | "NO_SHOW" | "CANCELLED" | string;
  buyer_key: string;
  deposit_paid: boolean;
  claim_id: string | null;
}

export interface SyntheticHistoryTable {
  id: string;
  tenant_id: string;
  judge_run_id: string;
  resource_id: string;
  service_id: string;
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  outcome: "ATTENDED" | "NO_SHOW" | "CANCELLED_LATE" | "CANCELLED_EARLY" | string;
  lead_time_hours: number;
  deposit_paid: boolean;
  buyer_key: string;
}
