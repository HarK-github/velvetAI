# velvetAI Epic 3.5 Integration Hardening Prompt

```text
Act as the Lead Integration Engineer and Security Reviewer for velvetAI.

This is a short integration-hardening sprint between Epic 3 and Epic 4.

Do not implement MCP, WebMCP, Ask AI, Bryntum, Judge Mode, Vault, Subscriptions, Payouts, multiparty onboarding, or live PayPal.

The objective is to ensure Epic 4 agents will operate on real database-backed booking workflows rather than mocks or in-memory production adapters.

READ COMPLETELY

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. @docs/PROJECT_STATUS_DOSSIER.md
5. All ADRs under @docs/decisions/
6. Current API, worker, database, booking, payment, web, and deployment code

SPEC_V1_1_AMENDMENT.md supersedes conflicting requirements in spec.md.

==================================================
W0 — BASELINE AND WORKSPACE HYGIENE
==================================================

1. Record:
   - git branch --show-current
   - git rev-parse HEAD
   - git status --short
2. Remove the accidental trailing blank-line diff from:
   - prompts/REPOSITORY_STATUS_AUDIT_PROMPT.md
3. Run:
   - git diff --check
   - pnpm lint
   - pnpm typecheck
   - pnpm test
   - pnpm build
4. Update docs/implementation-progress.md.

Do not begin implementation if baseline application checks fail.

==================================================
W1 — TOOLCHAIN, LICENSE, AND CREDENTIAL HYGIENE
==================================================

Node version:

- The specification requires Node.js 24 LTS.
- The audit found Node v22.23.3.
- Pin an exact current Node 24 LTS patch through mise.toml.
- Set package.json engines to >=24 <25.
- Ensure pnpm 12 remains pinned exactly.
- Reinstall and rerun the full verification suite under Node 24.
- Record the version transition.

License:

- Add an MIT LICENSE file at repository root.
- Keep root package.json private: true; this prevents accidental npm publication and does not prevent the repository from being open source.
- Add package.json license metadata where appropriate.
- Add the license to README.

Database credential hygiene:

- The migration/report references a fixed velvet_runtime password.
- No production migration or tracked file may contain a fixed database password.
- Remove literal passwords from migrations, tests, documentation, compose files, and examples.
- Provision runtime credentials through environment/managed database configuration.
- Tests may create an ephemeral restricted role with a per-run random credential, or use an isolated no-login role plus role membership.
- Never print generated passwords.

Required evidence:

- git grep finds no fixed runtime password.
- Node 24 executes lint, typecheck, tests, and build.
- LICENSE exists.

==================================================
W2 — REAL DATABASE-BACKED CATALOG AND AVAILABILITY
==================================================

The audit found:

- GET /v1/services reads MOCK_SERVICES.
- GET /v1/availability uses a deterministic in-memory slot generator.

Replace these production paths with PostgreSQL-backed queries.

Services:

1. Derive tenant from authentication where protected.
2. Query services and current published service_versions.
3. Return only active services for the tenant/location.
4. Preserve immutable version identifiers, duration, buffers, price, deposit, currency, and cancellation-policy reference.
5. Remove production dependence on MOCK_SERVICES.
6. Keep explicit test fixtures inside tests only.

Availability:

1. Read service requirements and location time zone.
2. Read matching resources and availability_rules.
3. Apply closures/exceptions if implemented.
4. Subtract active blocking resource_claims.
5. Include service buffers.
6. Use half-open intervals.
7. Return schedule revision and authoritative UTC/local times.
8. Do not claim forecast fill probability yet unless the forecasting package actually produced it.
9. Remove simulated fill scores from production responses.

Requirements:

- Availability remains advisory.
- Hold creation revalidates through the GiST constraint.
- All queries run through withTenantTransaction.
- Cross-tenant IDs return no data.

Tests:

- Service query uses real PostgreSQL.
- Published/current version behavior.
- Inactive services omitted.
- Availability removes held/confirmed claims.
- Expired claims block until reaped.
- Buffers prevent adjacent overlap where configured.
- DST gap/overlap behavior.
- Tenant isolation.

==================================================
W3 — MUTATION IDEMPOTENCY COVERAGE
==================================================

The audit found several mutating POST routes without declared Idempotency-Key enforcement.

Audit every mutating route.

Require Idempotency-Key for:

- POST /v1/booking-quotes
- POST /v1/bookings/prepare
- POST /v1/booking-holds
- POST /v1/booking-approvals/:locator/confirm
- POST /v1/bookings/commit
- POST /v1/bookings/:bookingId/payment-order
- POST /v1/payments/:paymentIntentId/capture
- POST /v1/captures/:captureId/refunds
- POST /v1/bookings/:bookingId/balance-invoice
- Future cancellation/reschedule/judge-reset mutations

If an endpoint is provably read-only despite POST semantics, document why and keep it out of the mutation list.

Rules:

- Canonical request hash includes route operation and authoritative actor/client context.
- Same key and same hash returns recorded result.
- Same key and different hash returns RFC 9457 HTTP 409.
- Concurrent identical requests converge to one operation.
- Idempotency records persist long enough for financial audit requirements.
- Provider request IDs remain distinct per PayPal operation.

Tests:

- Same key/same body.
- Same key/different body.
- Same key across different operations.
- Same key across tenants.
- 100 concurrent identical requests.
- Response replay preserves original HTTP status and body.

==================================================
W4 — COMPLETE CANCELLATION AND ATTENDANCE MINIMUM
==================================================

The audit found:

- prepare-cancellation exists.
- Commit cancellation is absent.
- Check-in/completed/no-show routes are absent.
- Balance invoicing depends on appointment completion.

Implement the minimum coherent lifecycle.

Cancellation:

1. prepare_cancellation returns immutable policy result and one-time confirmation flow.
2. commit_cancellation accepts only approved cancellation artifact/token and idempotency key.
3. Lock booking, payment capture, refund reservations, and resource claim.
4. If capture is uncertain, move to CANCEL_REQUESTED and reconcile before release.
5. If capture completed, reserve and dispatch deterministic policy refund.
6. Release resource claim only at the legal point.
7. Append audit and outbox events.

Attendance merchant routes:

- POST /v1/bookings/:id/check-in
- POST /v1/bookings/:id/complete
- POST /v1/bookings/:id/no-show

Rules:

- Require scheduler/manager role as specified.
- No-show only after appointment start plus grace period.
- Completed/no-show/cancelled terminal transitions are append-only events.
- Completion permits balance invoice creation.
- No client or model chooses refund amount.

Rescheduling and waitlist remain deferred to Epic 5 unless required by existing demo commitments.

Tests:

- Cancellation before/after cutoff.
- Cancellation during CAPTURE_UNCERTAIN.
- Cancellation/refund/expiry race.
- Check-in before start policy.
- No-show before grace period fails.
- Completed appointment can create one balance invoice.
- Idempotent repeated transitions.

==================================================
W5 — POSTGRESQL OUTBOX AND RECONCILIATION WORKERS
==================================================

The audit found the deployed worker defaults to InMemoryOutboxStore.

Implement PostgreSqlOutboxStore.

Requirements:

1. PostgreSQL outbox remains authoritative.
2. Claim events with FOR UPDATE SKIP LOCKED.
3. Use fenced lease token and expiry.
4. Commit claim before processing external work.
5. Record consumer inbox event in the same transaction as durable side effect.
6. Retry with bounded exponential backoff and jitter.
7. Dead-letter after configured attempts.
8. Stale worker may not acknowledge a reclaimed lease.
9. InMemoryOutboxStore remains test-only.
10. Production worker startup must fail if configured with in-memory storage.

Wire real processors for:

- Hold expiration.
- PayPal provider-operation reconciliation.
- Unknown refund reconciliation.
- Verified webhook reduction if currently only callable.
- Notification event logging/no-op adapter where delivery is deferred.

Add a reconciliation scheduler/loop using idx_provider_operations_reconcile.

Tests:

- Crash before side effect.
- Crash after side effect but before acknowledgement.
- Lease expiry and reclaim.
- Stale acknowledgement fails.
- Duplicate delivery creates one durable side effect.
- Reconciliation job resumes after restart.
- Production configuration cannot silently select in-memory storage.

BullMQ remains deferred.

==================================================
W6 — DOCUMENTATION AND NFR CORRECTION
==================================================

Correct documentation drift:

- README says 16 RLS tables; actual count is higher after Epic 3.
- Document the exact current count from database introspection.
- Update repository diagrams to show PostgreSQL-backed catalog/availability and worker.

Correct NFR traceability.

Do not invent or replace specification targets.

The canonical spec targets include:

- Cached availability p95 under 300 ms and p99 under 800 ms.
- Uncached availability p95 under 800 ms and p99 under 1.5 seconds.
- Quote/hold p95 under 500 ms and p99 under 1 second excluding providers.
- Internal command p95 under 700 ms and p99 under 1.5 seconds.
- Production RPO five minutes or better.
- Production RTO 60 minutes or better.
- Initial throughput targets from spec.md.

Local unit-test timing does not verify p95/p99 or throughput.

Mark NFRs IMPLEMENTED_UNVERIFIED until proper k6/load and deployment tests run.

Add a basic k6 script for:

- Cached availability reads.
- Uncached availability reads.
- Quote creation.
- Non-conflicting holds.
- One hot-resource conflict test.

Do not claim the NFR passed unless the target load and percentile evidence are recorded.

==================================================
W7 — DEPLOYMENT SCAFFOLD
==================================================

Prepare—but do not necessarily deploy—the stable Render architecture.

Add:

- Dockerfile or clear native Render build/start configuration for API.
- Build/start configuration for web static site.
- Worker start configuration.
- Pre-deploy migration command.
- render.yaml where supported.
- Health/readiness paths.
- Environment-variable documentation.
- Sandbox-only PayPal enforcement.

Do not include credentials.

Do not register a temporary webhook in code.

The deployment shall support:

- Web static site.
- API service.
- Worker service.
- PostgreSQL.
- Stable HTTPS webhook URL.

Redis may remain unused while BullMQ is deferred.

==================================================
MANUAL ACTIONS TO RECORD
==================================================

Record as external dependencies:

1. Obtain authorized Bryntum hackathon access/license before Epic 5.
2. Confirm Render account/project access.
3. Confirm GitHub repository can become public before submission.
4. Confirm Devpost team members and repository ownership.

Do not purchase unrelated services.

==================================================
OUT OF SCOPE
==================================================

Do not implement:

- MCP network transport.
- WebMCP.
- Ask AI.
- LLM provider.
- Bryntum UI.
- Forecast UI.
- Judge Mode.
- Abuse Lab UI.
- Rescheduling unless already required by active tests.
- Waitlist unless already required by active tests.
- Live PayPal.
- Vault.
- Subscriptions.
- Payouts.
- Multiparty onboarding.
- BullMQ.

==================================================
DEFINITION OF DONE
==================================================

Epic 3.5 is complete only when:

1. Working tree hygiene issue is resolved.
2. Node 24 LTS and pnpm exact versions are pinned.
3. Full verification passes under Node 24.
4. MIT LICENSE exists and README references it.
5. No tracked fixed database password exists.
6. GET /v1/services uses PostgreSQL.
7. GET /v1/availability uses PostgreSQL rules/resources/claims.
8. Production code no longer returns mock services or simulated fill scores.
9. Every true mutation enforces idempotency.
10. Cancellation can be prepared and committed safely.
11. Check-in, completion, and no-show minimum routes exist.
12. Production worker uses PostgreSqlOutboxStore.
13. Provider reconciliation runs in the worker.
14. In-memory outbox cannot be selected silently in production.
15. README and status docs reflect actual RLS count and architecture.
16. NFR targets match spec and are not falsely marked verified.
17. Deployment scaffolding exists without secrets.
18. pnpm lint passes.
19. pnpm typecheck passes.
20. pnpm test passes.
21. pnpm build passes.
22. git diff --check passes.
23. docs/implementation-progress.md contains exact evidence.

Stop after this integration-hardening sprint.
Do not begin Epic 4.

==================================================
FINAL HANDOFF
==================================================

Report:

1. Work phase status.
2. Files changed.
3. Node/toolchain change.
4. License and credential cleanup.
5. Catalog/availability database integration.
6. Idempotency route matrix.
7. Cancellation/attendance implementation.
8. Outbox/reconciliation worker design.
9. Deployment scaffolding.
10. Commands and exact results.
11. Load-test evidence and unverified NFRs.
12. Known limitations.
13. Spec deviations and ADRs.
14. Exact readiness for Epic 4.

Do not claim checks were run when they were not.
Do not hide skipped or failed tests.
```
