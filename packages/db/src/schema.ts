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
  payment_intents: PaymentIntentTable;
  payment_captures: PaymentCaptureTable;
  refunds: RefundTable;
  invoices: InvoiceTable;
  webhook_events: WebhookEventTable;
  idempotency_records: IdempotencyRecordTable;
  outbox_events: OutboxEventTable;
  inbox_events: InboxEventTable;
  audit_events: AuditEventTable;
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
  starts_at: ColumnType<Date, string | Date, never>;
  ends_at: ColumnType<Date, string | Date, never>;
  resource_id: string | null;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface ResourceClaimTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  resource_id: string;
  blocked_during: unknown; // tstzrange in PostgreSQL
  state: string;
  expires_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface PaymentIntentTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider_order_id: string | null;
  amount_minor: string;
  currency: string;
  state: string;
  request_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface PaymentCaptureTable {
  id: string;
  tenant_id: string;
  payment_intent_id: string;
  provider_capture_id: string;
  amount_minor: string;
  state: string;
  captured_at: ColumnType<Date | null, string | Date | null, string | Date | null>;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface RefundTable {
  id: string;
  tenant_id: string;
  capture_id: string;
  provider_refund_id: string | null;
  amount_minor: string;
  state: string;
  request_id: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface InvoiceTable {
  id: string;
  tenant_id: string;
  booking_id: string;
  provider_invoice_id: string | null;
  balance_minor: string;
  currency: string;
  state: string;
  created_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface WebhookEventTable {
  id: string;
  tenant_id: string | null;
  transmission_id: string;
  provider_event_id: string | null;
  verification_state: string;
  processing_state: string;
  raw_payload: string;
  received_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface IdempotencyRecordTable {
  id: string;
  tenant_id: string;
  actor_id: string;
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
