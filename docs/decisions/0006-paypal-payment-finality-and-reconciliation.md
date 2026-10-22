# 6. PayPal Payment Finality, Provider Operation Journal, and Reconciliation

## Status

Accepted

## Context

VelvetAI integrates with PayPal to secure appointments with forecast-sized deposits. Autonomous agents and web buyers interact with the platform under high concurrency, intermittent network connectivity, out-of-order webhook delivery, and potential payment tampering.

Key failure modes and attack vectors include:

1. **Payer Action vs. Payment Finality Confusion**: PayPal JavaScript SDK v6 `onApprove` or an Orders v2 order status of `APPROVED` or `COMPLETED` does not guarantee funds capture. A contained capture resource may remain in `PENDING`, `DECLINED`, or `FAILED` state. Confirming appointments prematurely creates insolvency and unpaid slot allocation.
2. **Payment Window vs. Slot-Hoarding**: If a buyer holds an appointment without completing payment, malicious agents or abandoned checkouts can monopolize provider availability. The local booking payment window and PayPal's order lifetime are distinct clocks.
3. **Unknown Mutation Outcomes**: Network timeouts or HTTP 5xx responses during order creation or capture leave the remote state uncertain. Naively retrying with a new request ID causes double-charging, while naively marking the booking failed causes orphaned captures.
4. **Webhook Spoofing and Replay**: Attackers can spoof unverified webhooks, alter payloads, or replay past events. Webhooks can also arrive out of order (e.g. `PAYMENT.CAPTURE.REFUNDED` before `PAYMENT.CAPTURE.COMPLETED`).
5. **Concurrent Refund Over-Drain**: Multiple concurrent refund requests against the same capture could exceed the captured deposit if not strictly serialized and reserved.
6. **Ledger Integrity**: Using PayPal Invoicing as the canonical financial record violates double-entry balancing rules and introduces external dependencies into local accounting truth.

## Decision

To enforce absolute payment finality, deterministic state progression, and ledger integrity (Specification v1.1 Amendment Sections F, G, and H, and Sprint Epic 3), we implement:

1. **Explicit Payment State Progression**:
   - Primary lifecycle:
     ```text
     COMMITTING
       → ORDER_CREATE_PENDING
       → REQUIRES_PAYER_ACTION
       → CAPTURE_IN_FLIGHT
       → CAPTURED
       → CONFIRMED
     ```
   - Unresolved / Exception lifecycles:
     - `ORDER_CREATE_PENDING → ORDER_CREATE_UNKNOWN → REQUIRES_PAYER_ACTION | PAYMENT_FAILED | MANUAL_REVIEW`
     - `REQUIRES_PAYER_ACTION → PAYMENT_WINDOW_EXPIRED` (releases claim)
     - `CAPTURE_IN_FLIGHT → CAPTURE_UNCERTAIN → CAPTURED | PAYMENT_FAILED | MANUAL_REVIEW`
     - `CAPTURED → REFUND_PENDING → PARTIALLY_REFUNDED | REFUNDED`
   - **Booking Confirmation Rule**: Booking status transitions to `CONFIRMED` _only_ when the contained capture resource status is explicitly `COMPLETED`:
     ```text
     purchase_units[].payments.captures[].status == COMPLETED
     ```
   - If capture is `PENDING`, booking moves to `CAPTURE_UNCERTAIN` and keeps the resource claim blocking until authoritative resolution.

2. **Decoupled Payment Window & Authoritative Slot Allocation**:
   - Upon buyer confirmation consumption (`COMMITTING`), a fixed `payment_expires_at` is set (default 10 minutes).
   - The resource claim remains blocking (`blocking = true`) throughout this window.
   - If `payment_expires_at` expires before capture is dispatched, the booking transitions to `PAYMENT_WINDOW_EXPIRED` and the resource claim transitions to `EXPIRED` (`blocking = false`). Any subsequent client capture attempts fail closed.
   - If capture dispatch is already in flight or outcome is uncertain, the claim remains blocking until reconciled.

3. **Persistent Provider Operation Journal (`provider_operations`)**:
   - Before any external mutation to PayPal (order creation, capture, refund, invoice), an operation record is committed to PostgreSQL in state `PREPARED` or `DISPATCHING`.
   - Binds: internal operation ID, tenant ID, booking ID, operation type, endpoint, stable `paypal_request_id`, and `canonical_payload_hash`.
   - Retries within the 6-hour provider idempotency retention window reuse the identical endpoint, request ID, and canonical payload.
   - Network timeouts or 5xx responses transition the operation to `SENT_UNKNOWN` and booking to `CAPTURE_UNCERTAIN`, returning HTTP 202 Accepted with a polling status URL.

4. **Durable Webhook Ingress & Out-of-Order Reconciliation**:
   - Ingress endpoint (`POST /v1/webhooks/paypal/:connectionKey`) preserves exact raw body `Buffer` bytes and transmission headers into `webhook_deliveries` with state `UNVERIFIED` before returning HTTP 200.
   - Verification occurs asynchronously via the PostgreSQL outbox and PayPal signature verification endpoint (`/v1/notifications/verify-webhook-signature`) with strict header and certificate URL allowlisting.
   - Upon successful verification, events are recorded in `verified_provider_events` with unique constraint `(environment, provider_connection_id, provider_event_id)`.
   - Handlers never derive state from arrival order; they query current authoritative PayPal resource state and apply idempotent transitions.

5. **Serialized Refund Reservations**:
   - Refunds execute under a PostgreSQL row-level lock (`FOR UPDATE`) on the target `payment_captures` row.
   - Requires: `requested_refund <= captured_amount - (completed_refunds + pending_refunds + unknown_refunds)`.
   - Prevents race conditions and double-refunds across concurrent API or agent requests.

6. **Authoritative Double-Entry Financial Journal**:
   - Local append-only financial journal (`financial_journal_entries`, `financial_journal_lines`) is the sole internal financial authority.
   - Enforces integer minor units and exact zero-sum balance per currency for every entry:
     - Deposit capture: Debit Cash (Asset) / Credit Customer Deposit (Liability).
     - Refund: Debit Customer Deposit (Liability) / Credit Cash (Asset).
   - Invoicing v2 is strictly a customer-facing balance billing projection after appointment completion; it never overrides or dictates payment capture state.

## Consequences

- Prevents slot-hoarding and abandoned holds without wall-clock drift.
- Eliminates phantom confirmations: buyers and agents cannot confirm bookings without verified `COMPLETED` PayPal captures.
- Survives process crashes and provider network drops without losing track of funds or double-charging.
- Guarantees internal accounting ledger integrity with zero-sum balanced entries.
- Requires all PayPal calls to maintain stable idempotent request IDs and durable journal entries.

## Alternatives Considered

- **Confirming booking upon PayPal SDK onApprove**: Rejected because client-side callbacks are untrusted and capture has not yet occurred on the backend.
- **Relying solely on PayPal order status `COMPLETED`**: Rejected because order status `COMPLETED` does not guarantee individual capture settlement (`capture.status == COMPLETED`).
- **Processing webhooks synchronously in HTTP handler**: Rejected because third-party provider verification timeouts would cause webhook delivery failures and dropped events.
- **Using PayPal Invoicing as ledger authority**: Rejected because PayPal invoices are customer billing representations, not an append-only double-entry ledger.
