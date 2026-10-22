# velvetAI Sprint Epic 4 Prompt

```text
Act as the Lead Agentic Systems Engineer, OAuth Security Engineer, and Product Implementation Lead for velvetAI.

Repository root: current working directory
Runtime: Node.js 24 LTS through mise
Package manager: pnpm 12
Primary model provider: Google Gemini
AI integration framework: Vercel AI SDK
Hosted identity provider: Auth0
MCP revision: 2026-07-28
WebMCP interface: document.modelContext

READ COMPLETELY BEFORE CHANGING CODE

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. @docs/PROJECT_STATUS_DOSSIER.md
5. All ADRs under @docs/decisions/
6. @prompts/EPIC4_AGENT_INTERFACES_PROMPT.md
7. Current tool registry, booking services, approval flow, auth plugin, API bootstrap, web routes and Abuse Lab

SPEC_V1_1_AMENDMENT.md supersedes conflicting requirements in spec.md.

PRIMARY OBJECTIVE

Implement Sprint Epic 4:

1. Stateless MCP Streamable HTTP interface using protocol revision 2026-07-28.
2. Auth0 OIDC/OAuth authentication for the hosted web and API.
3. Scope-aware MCP authorization.
4. Real tool execution through the existing BookingService and database.
5. Secure two-phase prepare/approve/commit workflow.
6. In-page Ask AI powered by Google Gemini through Vercel AI SDK.
7. WebMCP progressive enhancement through document.modelContext.
8. Deterministic prompt-injection and excessive-agency defenses.
9. Transport-equivalence and external-provider verification.

Do not implement Bryntum, Judge Mode, Abuse Lab UI, forecast UI, live PayPal, Vault, Subscriptions, Payouts, multiparty onboarding, BullMQ or unrelated Epic 5 work.

==================================================
W0 — BASELINE AND DEPENDENCY PLAN
==================================================

1. Record:
   - git branch --show-current
   - git rev-parse HEAD
   - git status --short
2. Require a clean Epic 3.5 checkpoint before implementation.
3. Run:
   - mise exec -- node --version
   - mise exec -- pnpm --version
   - mise exec -- pnpm lint
   - mise exec -- pnpm typecheck
   - mise exec -- pnpm test
   - mise exec -- pnpm build
   - git diff --check
4. Create ADR 0007 covering:
   - MCP 2026-07-28 stateless transport.
   - Auth0 as identity provider.
   - Local membership as tenant/RBAC authority.
   - Gemini through Vercel AI SDK.
   - WebMCP as progressive enhancement only.
   - Deterministic policy boundary around all models and agents.
5. Update docs/implementation-progress.md before implementation.

Inspect current package versions before installing.

Pin exact versions without caret ranges for:

- @modelcontextprotocol/server
- @modelcontextprotocol/node
- @modelcontextprotocol/fastify
- ai
- @ai-sdk/google
- @ai-sdk/react
- @auth0/auth0-react
- webmcp-types, if used

Use the current compatible stable versions verified from official documentation.

Do not install legacy @modelcontextprotocol/sdk v1.

==================================================
W1 — AUTH0 IDENTITY AND API AUTHORIZATION
==================================================

Auth0 provides identity and OAuth/OIDC tokens.

velvetAI PostgreSQL memberships remain authoritative for:

- tenant_id
- local user ID
- role
- permissions
- role version
- revocation status

Implement:

1. Auth0 SPA integration for the React/Vite application using Authorization Code with PKCE.
2. Access tokens held in memory, not localStorage.
3. Existing Fastify auth port backed by Auth0 JWT verification.
4. JWKS caching and key rotation.
5. Exact validation of:
   - issuer
   - audience
   - expiry
   - not-before
   - allowed signing algorithm
6. Mapping Auth0 subject to app_users.oidc_subject.
7. Local membership lookup on every consequential command.
8. Scope and local-role enforcement.
9. Immediate rejection of revoked membership or stale role version.

Recommended scopes:

- booking:read
- booking:quote
- booking:prepare
- booking:commit
- booking:cancel
- merchant:schedule
- merchant:refund

MCP clients receive only the scopes required by their registered use.

Implement OAuth Protected Resource Metadata at the correct well-known endpoint, identifying:

- velvetAI API resource.
- Auth0 authorization server.
- Supported bearer-token methods.
- Supported scopes.

Use Auth0's discovery metadata as the authorization-server source of truth.

Do not implement dynamic client registration unless Auth0 and the MCP client require it. Use pre-registered demo clients for the hackathon.

Required configuration:

Server-only:

- AUTH0_ISSUER
- AUTH0_AUDIENCE
- AUTH0_JWKS_URI, only if not derived safely from issuer

Public web:

- VITE_AUTH0_DOMAIN
- VITE_AUTH0_CLIENT_ID
- VITE_AUTH0_AUDIENCE

Never expose Auth0 management credentials.

Add:

- docs/setup/auth0.md
- .env.example placeholders

The setup guide shall explain how the user creates:

1. Auth0 tenant.
2. velvetAI API/audience.
3. velvetAI Web SPA application.
4. Optional pre-registered MCP demo client.
5. Callback, logout and allowed-origin URLs for local and Render staging.

Do not place real tenant names, client IDs or secrets in committed documentation.

==================================================
W2 — MCP 2026-07-28 STREAMABLE HTTP
==================================================

Use official v2 packages:

- @modelcontextprotocol/server
- @modelcontextprotocol/node
- @modelcontextprotocol/fastify

Use createMcpHandler with a fresh McpServer per request.

Use toNodeHandler for Fastify/Node integration.

Mount:

```text
POST /mcp
```

Required protocol behavior:

1. Stateless per request.
2. No Mcp-Session-Id.
3. No initialize handshake for 2026-07-28.
4. Every request includes MCP-Protocol-Version.
5. Header protocol version matches request `_meta`.
6. Unsupported/mismatched versions return the official MCP error shape.
7. Implement server/discover.
8. Implement tools/list and tools/call.
9. GET and DELETE session-style requests return 405 or official method error.
10. Do not derive authorization from clientInfo.
11. Use explicit server-minted handles for cross-call state.

Support 2026-07-28 as authoritative.

If legacy 2025 stateless fallback is retained for client compatibility:

- Use the same server factory and tool definitions.
- Document the fallback.
- Do not enable sessionful behavior.
- Test that security policy is identical across revisions.

Security:

- Validate bearer token before invoking MCP handler.
- Attach validated auth info to the request context.
- Derive tenant from local membership.
- Enforce resource/audience and scopes.
- Validate Host and Origin using explicit allowlists.
- Configure allowed Render API hostname and approved local hosts.
- Reject present unauthorized Origins.
- Do not allow wildcard HTTPS origins.
- Never pass MCP bearer tokens to PayPal, Gemini or another upstream.
- Apply body size, request timeout, concurrency and rate limits.

MCP budgets:

- 60 calls/minute/client.
- 10 concurrent calls/client.
- 20 tool calls/run.
- 30-second wall-clock budget.
- Maximum input/output sizes from spec.

# ==================================================
W3 — SHARED TOOL EXECUTION BRIDGE

The existing ToolRegistry remains the source of tool metadata.

Replace mock production handlers with adapters that invoke real application services.

Implement versioned tools:

- list_services.v1
- find_available_slots.v1
- quote_booking.v1
- prepare_booking.v1
- get_booking.v1
- prepare_cancellation.v1
- commit_booking.v1
- commit_cancellation.v1

Use closed Zod/JSON schemas:

- additionalProperties: false
- bounded strings and arrays
- validated UUIDs/timestamps/currency
- no tenant_id
- no payee
- no caller-selected refund amount
- no arbitrary URL
- no raw PayPal operation

Tool authorization:

- list/find/get require booking:read.
- quote requires booking:quote.
- prepare requires booking:prepare.
- commit requires booking:commit and valid buyer confirmation.
- cancellation scopes follow the same separation.

Consequential behavior:

- Availability and service listing are read-only.
- Quote creation is idempotent but may persist a quote.
- prepare_booking creates a scarce inventory hold and is consequential.
- commit_booking is consequential and cannot execute without one-time buyer confirmation.
- prepare_cancellation is non-final but may reveal policy terms.
- commit_cancellation is consequential.

Every transport must invoke the same BookingService/PaymentService methods and deterministic policy checks.

Do not duplicate business logic in MCP, WebMCP or Ask AI adapters.

# ==================================================
W4 — MCP TWO-PHASE HUMAN APPROVAL

prepare_booking.v1 shall:

1. Authenticate actor, client and tenant.
2. Resolve real DB-backed service/availability.
3. Create the hold and immutable snapshot.
4. Return:
  - opaque hold/intent reference
  - approval interaction URL
  - exact non-sensitive terms
  - expiry
5. Never return a raw confirmation token to the model.

MCP approval flow:

- Use the current MCP Multi Round-Trip Request/input_required or URL-mode elicitation supported by the official SDK.
- Navigation acceptance is not transaction approval.
- Browser approval is completed only by velvetAI's hardened approval route.
- The confirmation remains server-side where possible.
- Retry of the original MCP request may reference only a server-issued handle.

commit_booking.v1 shall:

- Accept the server-issued intent/operation handle and idempotency key.
- Retrieve the confirmation server-side.
- Fail when confirmation is absent, expired, consumed, wrong actor, wrong client, wrong tenant or wrong intent.
- Never accept amount, currency, payee, slot, policy or raw confirmation details from the model.

If the official SDK does not support the desired approval pattern cleanly:

- Return a structured input_required result with a trusted approval URL.
- Keep the tool operation pending.
- Document the limitation.
- Do not invent a proprietary response that is mislabeled standard MCP.

# ==================================================
W5 — IN-PAGE ASK AI WITH GEMINI

Use Vercel AI SDK with:

- `ai`
- `@ai-sdk/google`
- `@ai-sdk/react`

Implement a model-provider port in the application layer.

Production adapter:

- Google Gemini.

Test adapter:

- Deterministic fake model.

Environment:

- AI_PROVIDER=gemini
- GOOGLE_GENERATIVE_AI_API_KEY
- AI_MODEL=

The Gemini key is server-only and must never use a VITE_ prefix.

Implement:

- POST /v1/ai/chat or the project-consistent chat route.
- Streaming server response.
- AskAIDrawer React component.
- `useChat`/transport pattern from the installed Vercel AI SDK version.
- Typed tool parts rendered separately from prose.
- Abort/cancel behavior.
- Explicit loading, error, rate-limit and provider-unavailable states.

Model tool policy:

- The model receives only allowlisted velvetAI tools.
- Read-only tools may execute server-side.
- State-changing prepare tools require explicit UI presentation.
- Commit tools are never automatically executed by model output.
- Trusted host/UI code completes human confirmation.
- The model never receives OAuth tokens, PayPal credentials, confirmation tokens, customer notes, tenant-wide PII or arbitrary database access.

Budgets:

- Maximum configured model steps.
- Maximum 20 tool calls/run.
- 30-second wall-clock.
- Token/input/output limits.
- Per-user and per-tenant rate limits.
- Abort provider call when client disconnects where supported.

Prompt boundary:

- System policy contains no secrets.
- User text is delimited as untrusted.
- Customer notes are excluded from planner context.
- Tool descriptions are versioned and reviewed.
- Tool outputs are structured and escaped.
- Model prose cannot update application state.

Real-provider acceptance:

- Add an opt-in Gemini E2E test.
- If no key is configured, mark BLOCKED/NOT_RUN.
- Do not claim Ask AI real-E2E verification from fake model tests.

Add:

- docs/setup/gemini.md
- provider-safe `.env.example` placeholders

Do not commit or print the Gemini key.

# ==================================================
W6 — WEBMCP PROGRESSIVE ENHANCEMENT

Use:

```text
document.modelContext
```

Do not use:

```text
navigator.modelContext
```

Feature detect:

```text
if ("modelContext" in document)
```

Implement a small adapter:

```text
apps/web/src/lib/webmcp.ts
```

Register only tools relevant to the current authenticated page/user.

Annotations:

- list_services: readOnlyHint true
- find_available_slots: readOnlyHint true
- get_booking: readOnlyHint true, potentially untrustedContentHint true
- quote_booking: readOnlyHint false, idempotent by backend
- prepare_booking: readOnlyHint false, consequentialHint true
- commit_booking: readOnlyHint false, consequentialHint true
- cancellation tools: consequential as appropriate

Rules:

- Hints are not authorization.
- Every execution calls authenticated velvetAI backend APIs.
- Default same-origin `tools` Permissions Policy.
- Do not configure exposedTo for cross-origin access.
- Register/unregister tools with page and auth lifecycle.
- Pin tool name, version and schema.
- Do not expose customer notes in tool output.
- Do not expose confirmation tokens.
- Do not make WebMCP a dependency for ordinary web or Ask AI flows.

Fallback:

- Ordinary forms remain functional.
- Ask AI remains functional.
- MCP remains separately functional.
- UI clearly indicates WebMCP availability for judge diagnostics without presenting it as an error.

# ==================================================
W7 — SECURITY MIDDLEWARE AND ABUSE LAB

Runtime enforcement:

- Tool allowlist.
- Scope and local-role checks.
- Agent/client/tenant binding.
- Request canonicalization.
- Idempotency.
- Tool/time/token budgets.
- Rate limiting.
- Confirmation boundary.
- Origin and Host validation.
- Prompt/content quarantine.
- Redacted structured audit events.

Extend Abuse Lab with real transport-level scenarios:

1. MCP protocol header/body mismatch.
2. Missing protocol version.
3. Unsupported protocol revision.
4. GET/DELETE session request against stateless endpoint.
5. Forged Auth0 issuer.
6. Wrong Auth0 audience/resource.
7. Missing scope.
8. Revoked local membership with otherwise valid Auth0 token.
9. Tool not in allowlist.
10. Model calls commit without browser confirmation.
11. MCP navigation accepted but approval not completed.
12. WebMCP cross-origin frame attempts execution.
13. WebMCP consequential hint removed by malicious client.
14. Tool/schema version changed after prepare.
15. Prompt injection in user request.
16. Prompt injection in tool output.
17. Tool-call loop exceeds budget.
18. Gemini timeout/disconnect.
19. Fake model versus real-provider result labeling.
20. Confirmation token or OAuth token requested through model.

Every Critical and High assertion must be deterministic.

Model refusal alone is not a passing control.

# ==================================================
W8 — TRANSPORT EQUIVALENCE TESTS

For the same authenticated buyer and inputs, verify:

- REST
- MCP
- WebMCP simulation
- In-page Ask AI

all invoke the same application handlers and produce the same:

- authorization result
- quote/hold snapshot
- policy hashes
- error codes
- audit events
- database state

Differences may exist only in presentation/transport envelopes.

Required tests:

- list services.
- find slots.
- quote.
- prepare booking.
- approval required.
- commit after valid human confirmation.
- replay failure.
- cancellation preparation.

# ==================================================
W9 — USER EXPERIENCE

Ask AI drawer shall:

- Show user's message and assistant response distinctly.
- Render service/slot options as structured cards.
- Show exact deposit, currency and cancellation policy.
- Mark authoritative tool data separately from model explanation.
- Provide an explicit Review Terms action.
- Open hardened approval surface.
- Never display raw confirmation token.
- Show booking state from API.
- Handle pending PayPal action without pretending payment is complete.
- Be keyboard accessible.
- Have clear empty/loading/error/rate-limit states.

Do not attempt final Bryntum integration in this epic.

# ==================================================
W10 — AUTH0 AND GEMINI MANUAL SETUP GATES

Create setup documentation before asking for credentials.

Auth0 real E2E status shall remain BLOCKED/NOT_RUN until:

- Auth0 tenant exists.
- SPA app exists.
- velvetAI API/audience exists.
- Local callback/logout/origin URLs configured.
- Staging URLs configured when available.
- Real login succeeds.
- API validates real access token.

Gemini real E2E status shall remain BLOCKED/NOT_RUN until:

- API key is stored locally/untracked or in Render secret storage.
- Real prompt streams.
- Real tool call invokes read-only/prepare flow.
- No secret enters browser or logs.

Never request that the user paste credentials into chat.

# ==================================================
OUT OF SCOPE

Do not implement:

- Bryntum.
- Forecast UI.
- Cash forecast.
- Abuse Lab UI.
- Judge reset.
- Render deployment beyond already prepared scaffolding.
- Rescheduling/waitlist unless required by current contracts.
- Live PayPal.
- Vault.
- Subscriptions.
- Payouts.
- Multiparty onboarding.
- BullMQ.
- Long-term chat memory.
- Vector database/RAG.
- Autonomous commit without human approval.

# ==================================================
DEFINITION OF DONE

Epic 4 is complete only when:

1. Baseline checks pass under Node 24.
2. Exact dependency versions are pinned.
3. Auth0 SPA login works in opt-in real E2E or is honestly BLOCKED.
4. Auth0 access token is validated by API.
5. Local membership remains authoritative for tenant and role.
6. OAuth Protected Resource Metadata is available.
7. MCP 2026-07-28 POST endpoint works.
8. No protocol sessions are used.
9. server/discover works.
10. tools/list works.
11. tools/call invokes real application services.
12. MCP scopes are enforced.
13. prepare_booking creates a real database hold.
14. commit_booking requires separate human confirmation.
15. In-page Ask AI streams from real Gemini or is honestly BLOCKED.
16. Fake model tests are clearly distinguished.
17. WebMCP uses document.modelContext.
18. WebMCP is progressive enhancement and same-origin.
19. REST/MCP/WebMCP/Ask AI policy equivalence tests pass.
20. Prompt-injection and excessive-agency tests pass.
21. Critical and High Abuse Lab transport scenarios pass.
22. pnpm format:check passes.
23. pnpm lint passes.
24. pnpm typecheck passes.
25. pnpm test passes.
26. pnpm build passes.
27. git diff --check passes.
28. docs/implementation-progress.md contains exact evidence.
29. No secrets or full external identifiers are committed.

Stop after Epic 4.
Do not begin Epic 5.

# ==================================================
FINAL HANDOFF

Report:

1. Work phase status.
2. Dependencies and exact versions.
3. Auth0 architecture and real-E2E status.
4. MCP transport and protocol behavior.
5. Tool execution bridge.
6. Human approval flow.
7. Gemini Ask AI implementation and real-E2E status.
8. WebMCP implementation and browser support/fallback.
9. Runtime security controls.
10. Abuse Lab additions.
11. Transport-equivalence evidence.
12. Web UX.
13. Commands and exact results.
14. Blocked/skipped tests.
15. Known limitations.
16. Spec deviations and ADR.
17. Exact readiness for Epic 5.

Do not claim external E2E success when credentials or supported browsers were unavailable.
Do not hide failures or skipped checks.

```

```

