# velvetAI Next-Phase Coding Prompt

Copy the prompt below into the coding LLM from the velvetAI repository root.

```text
Act as the Lead Implementation Engineer and Security-Conscious Payment Systems Engineer for velvetAI.

Repository root: current working directory
Operating environment: macOS, Zsh
Package manager: pnpm
Runtime manager: mise
Database: PostgreSQL 17+
Payment environment: PayPal Sandbox only

READ THESE FILES COMPLETELY BEFORE CHANGING CODE

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. Existing ADRs under @docs/decisions/

SOURCE-OF-TRUTH ORDER

- SPEC_V1_1_AMENDMENT.md supersedes conflicting language in spec.md.
- spec.md remains authoritative for requirements not changed by the amendment.
- Existing code is not automatically authoritative when it conflicts with either specification.
- Record every necessary deviation in docs/implementation-progress.md and an ADR.

CURRENT REPORTED STATE

Phase 0 and Sprint Epic 1 are reported complete:

- pnpm/Turborepo strict TypeScript monorepo.
- Fastify API and React/Vite web shell.
- PostgreSQL/Kysely migrations.
- Tenant-aware domain and application ports.
- Idempotency, audit, outbox/inbox foundations.
- Worker and initial Abuse Lab.
- Shared contracts, tool registry, PayPal adapter scaffold, forecasting scaffold, and observability.
- install, lint, typecheck, tests, and build reportedly pass.

Do not trust the report blindly. Inspect the repository and reproduce relevant checks.

PRIMARY OBJECTIVE

Implement and verify Sprint Epic 2: concurrency-safe booking.

Do not implement PayPal side effects in this run.

PayPal remains Sprint Epic 3. Payment ports, provider-operation types, and adapter contracts may be prepared only where necessary to preserve the architecture.

==================================================
WORK PHASES
==================================================

W0 — Repository and Specification Audit

1. Read all required files.
2. Inspect git status and the monorepo.
3. Compare migrations, domain state machines, RLS, idempotency, and worker behavior against the amendment.
4. Run the current baseline:
   - pnpm install --frozen-lockfile
   - pnpm lint
   - pnpm typecheck
   - pnpm test
   - pnpm build
5. Update docs/implementation-progress.md with actual results.
6. Ask questions only if a decision makes implementation impossible.

W1 — Slot Claim and RLS Hardening

1. Verify the resource-claim overlap predicate uses persisted state, never now().
2. Add or correct:
   - Persisted blocking state.
   - Half-open tstzrange.
   - GiST exclusion constraint.
   - Calendar B-tree index.
   - Hold-expiry partial B-tree index.
3. Ensure capacity greater than one uses discrete resource units.
4. Enable and force RLS on tenant-owned booking tables.
5. Use a NOBYPASSRLS runtime role.
6. Set tenant context transaction-locally on the same pooled connection as the query.
7. Add composite tenant foreign keys.

W2 — Quote, Hold, and Expiration

Implement:

- Versioned booking quote.
- Maximum five-minute quote TTL.
- Immutable service/price/policy snapshots.
- Short-lived slot hold.
- Resource claim insertion.
- Hold quotas.
- Hold expiration worker.
- Targeted stale-hold cleanup.
- Replacement-slot response on conflict.

Rules:

- Availability reads are advisory.
- The GiST exclusion constraint is authoritative.
- Map named 23P01 overlap failures to RFC 9457 HTTP 409 slot_unavailable.
- Use database time.
- Polling and retries shall not extend hold expiry.
- No network calls inside booking transactions.

W3 — Signed Intent and Buyer Confirmation

Implement:

1. Immutable server-side hold snapshot.
2. ES256 signed booking intent.
3. Separate one-time opaque buyer-confirmation record.
4. Hardened approval interaction endpoint.
5. Exact prepare_booking.v1 and commit_booking.v1 contracts.

prepare_booking.v1 shall:

- Derive actor, client, and tenant from authentication.
- Validate a closed schema.
- Canonicalize input.
- Resolve authoritative slot, merchant, amount, currency, deposit, and policy.
- Create the short-lived hold.
- Persist the immutable snapshot.
- Create the signed intent.
- Return a non-authorizing approval locator.

commit_booking.v1 shall accept only:

{
  "intent": "<signed-intent>",
  "confirmation": "<one-time-confirmation>",
  "idempotency_key": "<random-client-key>"
}

It shall not accept mutable copies of amount, currency, payee, service, slot, deposit tier, or cancellation policy.

W4 — Atomic Commit Operation

In one transaction:

1. Lock idempotency/commit operation.
2. Lock hold.
3. Lock confirmation.
4. Verify actor/client/tenant.
5. Verify intent, binding and schema hashes.
6. Verify hold and policy versions.
7. Verify current membership and authorization.
8. Verify database time is before expiry.
9. Consume the confirmation exactly once.
10. Transition the hold to COMMITTING.
11. Append audit and outbox events.
12. Commit.

Required uniqueness:

- tenant_id + intent_jti
- tenant_id + confirmation_jti
- tenant_id + client_id + idempotency_key

Do not call PayPal, Redis, email, an LLM, or any network service while this transaction is open.

W5 — REST and Tool Contracts

Expose the application behavior through REST.

Update the shared tool registry with schemas for:

- find_available_slots
- quote_booking
- prepare_booking
- get_booking
- prepare_cancellation

commit_booking may be represented in the registry, but MCP/WebMCP execution shall remain disabled behind feature flags until Epic 4.

All routes and tool definitions shall call the same application handlers.

W6 — Verification and Handoff

Run all required unit, property, integration, concurrency, RLS, API, worker, lint, typecheck, build, and migration tests.

Update:

- docs/implementation-progress.md
- ADRs
- README setup/run commands
- OpenAPI

Stop after Epic 2.

==================================================
NON-NEGOTIABLE INVARIANTS
==================================================

- PostgreSQL is the booking source of truth.
- Availability is advisory.
- Every tenant-owned row has non-null tenant_id.
- Tenant identity comes only from authenticated membership.
- Missing tenant context fails closed.
- Money uses bigint minor units.
- Times are UTC timestamptz plus IANA time zone.
- Appointment ranges are [start, end).
- Persisted blocking state—not wall-clock interpretation—controls overlap.
- Exactly one active claim may exist for a capacity-one resource and interval.
- Quote, price, deposit, payee, and cancellation-policy snapshots are immutable.
- Every mutation supports idempotency.
- Same idempotency key plus different canonical hash returns 409.
- Domain mutation and outbox event commit together.
- Signed intent integrity and buyer confirmation are separate trust claims.
- A model, browser flag, MCP annotation, or client boolean cannot authorize commit.
- No network call occurs inside the booking commit transaction.

==================================================
REQUIRED TESTS
==================================================

Use real PostgreSQL 17 through Testcontainers. Do not replace these with mocks.

1. Same-slot barrier race:
   - Run at least 100 concurrent hold attempts.
   - Exactly one blocking claim commits.
   - All others receive the expected overlap conflict.

2. Tenant and resource independence:
   - Identical intervals in different tenants/resources both succeed.

3. Range boundaries:
   - Back-to-back half-open ranges succeed.
   - Positive overlap fails.
   - Empty or negative intervals fail.
   - DST gap and overlap cases are deterministic.

4. Confirm/expire/replacement race:
   - Old hold confirms and replacement fails, or old hold expires and exactly one replacement wins.
   - Two blockers never coexist.

5. Long-transaction expiry:
   - Begin before expiry and attempt confirmation after expiry.
   - Commit must fail.

6. Reaper replicas:
   - Multiple workers use SKIP LOCKED.
   - Killed workers do not lose holds.
   - Every expired hold eventually transitions once.

7. RLS pool leakage:
   - Pool size one.
   - Alternate tenants through commit, rollback, exception, timeout, and missing context.
   - No prior tenant context may appear.

8. Confirmation replay:
   - Sequential and concurrent replay creates one operation.

9. Artifact mismatch:
   - Intent A plus Confirmation B fails.
   - Actor/client/tenant substitution fails.
   - Tool/schema/version change fails.

10. Canonicalization:
   - Duplicate keys, unknown properties, Unicode normalization differences, exponent numbers, negative values, overflow, and currency-scale mismatch are rejected or canonicalized deterministically.

11. JWS attacks:
   - alg none.
   - Algorithm confusion.
   - Unknown kid.
   - Remote jku/x5u.
   - Wrong typ/issuer/audience.

12. Crash recovery:
   - Commit state and outbox remain consistent at each injected transaction boundary.

==================================================
OUT OF SCOPE FOR THIS RUN
==================================================

Do not implement:

- PayPal create/capture/refund calls.
- Live or sandbox side effects.
- Webhook receiver.
- Invoicing.
- Vault.
- Subscriptions.
- Payouts.
- BullMQ migration.
- MCP execution transport.
- WebMCP execution.
- LLM calls.
- Bryntum final UI.
- Judge reset.

Adapter interfaces and feature flags are allowed.

==================================================
DEFINITION OF DONE
==================================================

Epic 2 is complete only when:

1. Existing baseline checks still pass.
2. PostgreSQL migrations apply and roll back.
3. Exclusion predicate uses persisted blocking state.
4. One hundred concurrent holds create exactly one active claim.
5. Adjacent time ranges coexist.
6. Expired holds stop blocking only after state transition.
7. Hold reapers recover after worker termination.
8. RLS context cannot leak through pooled connections.
9. Signed intent is bound to the immutable hold snapshot.
10. Buyer confirmation is stored and consumed separately.
11. Intent/confirmation replay and mix-and-match attacks fail.
12. Commit creates one COMMITTING operation and one outbox event.
13. No network call occurs inside the commit transaction.
14. API contracts and RFC 9457 errors are documented.
15. docs/implementation-progress.md contains exact evidence.
16. No PayPal side effects were added.

==================================================
PROGRESS REPORT
==================================================

Update docs/implementation-progress.md:

- Before implementation.
- At the start/end of each W phase.
- After each test group.
- On every blocker or deviation.
- Before final handoff.

Do not mark work VERIFIED without command/test evidence.

==================================================
FINAL HANDOFF
==================================================

Report:

1. Work phases and status.
2. Files changed.
3. Schema/migration changes.
4. Application/domain changes.
5. API/tool contracts.
6. Security controls.
7. Commands run and exact results.
8. Test evidence, including concurrency counts.
9. Known limitations.
10. Spec deviations and ADRs.
11. Exact next work for Sprint Epic 3.

Do not claim commands were run when they were not.
Do not hide failing checks.
Do not proceed to PayPal Epic 3.
```
