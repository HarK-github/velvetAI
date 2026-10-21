# 5. Concurrency-Safe Booking, Signed Intents, and RLS Isolation

## Status

Accepted

## Context

VelvetAI allows buyers and autonomous AI agents to discover services, negotiate appointment slots, and commit bookings. This creates high-concurrency attack surfaces:
1. Slot-hoarding and concurrent race conditions where multiple actors attempt to hold the exact same appointment window.
2. Replay, parameter tampering, and mix-and-match attacks where an agent attempts to substitute lower prices, alter cancellation policies, or reuse authorization tokens.
3. Cross-tenant data leakage when database connections are pooled and shared across asynchronous requests.
4. Volatile time predicates in database indexes (`hold_expires_at > now()`) that violate PostgreSQL index immutability rules.

## Decision

To ensure deterministic concurrency safety, cryptographic integrity, and strict multi-tenant isolation (Sprint Epic 2 and Specification v1.1 Amendment Sections B, C, D, and E), we implement:

1. **Persisted Blocking State & GiST Exclusion Constraint**:
   - `resource_claims` enforces slot conflict prevention via PostgreSQL GiST exclusion:
     ```sql
     EXCLUDE USING gist (
       tenant_id WITH =,
       resource_id WITH =,
       blocked_during WITH &&
     ) WHERE (blocking)
     ```
   - Overlap protection depends exclusively on the persisted `blocking` boolean column (`true` for `HELD`, `COMMITTING`, `CAPTURE_UNCERTAIN`, `CONFIRMED`; `false` for `EXPIRED`, `CANCELLED`, `RELEASED`), never wall-clock functions.
   - Named PostgreSQL `23P01` exclusion errors map deterministically to RFC 9457 HTTP 409 `slot_unavailable` responses with suggested next available slots.

2. **Dual Trust Claim Architecture**:
   - `prepare_booking` persists an immutable server-side snapshot in `booking_hold_snapshots` and issues a cryptographically signed booking intent (ES256 IEEE-P1363 JWS, strict headers: `typ: velvetai-intent+jwt`, `alg: ES256`, explicit `kid`, pinned `iss`/`aud`, bounded `exp`/`nbf`).
   - A non-authorizing approval locator (`/v1/booking-approvals/loc_<hex>`) directs the human buyer to an interactive confirmation endpoint.
   - Upon explicit buyer consent, an opaque single-use buyer confirmation record is stored in `buyer_confirmations`.
   - `commit_booking` requires both the signed intent and the buyer confirmation token. In a single ACID transaction, it locks the hold, confirmation, and idempotency records, verifies database time (`clock_timestamp() < hold_expires_at`), marks the confirmation consumed, transitions the hold to `COMMITTING`, and emits the `booking.committing` transactional outbox event. Zero network calls occur inside this transaction.

3. **Transaction-Local Row-Level Security (RLS)**:
   - All 16 tenant-owned tables enforce `FORCE ROW LEVEL SECURITY` with `tenant_isolation_policy` checking `current_setting('app.tenant_id', true) = tenant_id::text`.
   - Queries and mutations execute within `withTenantTransaction(db, tenantId, ...)` using `SET LOCAL app.tenant_id`. Because `SET LOCAL` is scoped strictly to the transaction, connections returned to the pool retain zero residual context, preventing cross-tenant leakage. Missing tenant context fails closed (0 rows visible, writes rejected).

4. **Concurrent Hold Reaping**:
   - Background workers query active tenants from the global `tenants` table and execute targeted batch cleanup using `FOR UPDATE SKIP LOCKED` inside tenant transactions.
   - Expired holds transition to `EXPIRED` with `blocking = false`, releasing the exclusion lock for subsequent holds and emitting `booking.expired` outbox events.

## Consequences

- Guarantees exactly one winner in 100+ concurrent hold races with zero double-bookings.
- Prevents price tampering, policy substitution, and token replay.
- Prevents cross-tenant context leakage across pooled connections.
- Requires all tenant database operations to run within `withTenantTransaction`.

## Alternatives Considered

- **Redis distributed locking**: Rejected because Redis locks do not guarantee ACID consistency with PostgreSQL rows, risk split-brain conditions, and leave orphan locks on worker crashes.
- **Client-supplied approval booleans / MCP annotations**: Rejected because untrusted client or agent assertions cannot be verified as authentic human buyer consent.
- **Volatile partial index (`hold_expires_at > now()`)**: Prohibited by PostgreSQL immutability constraints.
