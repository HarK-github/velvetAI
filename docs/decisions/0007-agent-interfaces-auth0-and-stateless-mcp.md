# 7. Agent Interfaces, Auth0 Identity Boundary, and Stateless MCP 2026-07-28

## Status

Accepted

## Context

VelvetAI enables autonomous AI agents and in-page assistants to discover services, find availability, quote bookings, prepare reservations, and initiate customer approvals. At the same time, autonomous booking and financial deposit commitments carry acute security and financial risks:

1. **Excessive Agency & Confused Deputy Attacks**: An AI agent or language model could attempt to finalize bookings, authorize financial charges, or refund money without authentic customer consent, or be tricked by prompt injection embedded in service descriptions, customer notes, or tool outputs.
2. **Session Hijacking & State Leakage in MCP**: Stateful MCP transports (such as WebSocket or session-bound HTTP with `Mcp-Session-Id`) introduce concurrency hazards, connection affinity requirements, and authorization context leakage across requests.
3. **Identity Provider vs. Multi-Tenant Authority Demarcation**: An external identity provider (Auth0) authenticates user identities and issues JWTs, but external token claims must never bypass local database multi-tenant isolation, role revisions, or instant permission revocation.
4. **Browser Integration Risks**: WebMCP allows browser-based agent interactions, but client-supplied hints or annotations must never be trusted as authorization. Furthermore, WebMCP implementations must progressively enhance modern browsers without breaking standard web workflows.

## Decision

To establish a hardened, transport-agnostic security boundary for AI agents (Specification v1.1 Amendment Sections D, E, and J, and Sprint Epic 4), we decide:

1. **Stateless MCP 2026-07-28 Streamable HTTP Transport**:
   - The Model Context Protocol (MCP) server is mounted at `POST /mcp` using the official v2 stable line:
     - `@modelcontextprotocol/server@2.3.1`
     - `@modelcontextprotocol/node@2.1.1`
     - `@modelcontextprotocol/fastify@2.0.1`
   - Every request is completely stateless. No `Mcp-Session-Id` header is used or accepted.
   - Per the 2026-07-28 revision, no `initialize` handshake is required; each request includes `MCP-Protocol-Version: 2026-07-28` in headers matching `_meta.protocolVersion`.
   - Supports official methods: `server/discover`, `tools/list`, and `tools/call`. Sessionful `GET` or `DELETE` requests fail closed with HTTP 405 / official error shapes.
   - Enforces strict Host and Origin allowlisting, preventing DNS rebinding and cross-origin hijacking.

2. **Auth0 Identity with Local PostgreSQL RBAC Authority**:
   - Auth0 provides identity verification and OAuth 2.0 / OIDC bearer tokens. The web application authenticates using Authorization Code Flow with PKCE; tokens are stored strictly in memory (`@auth0/auth0-react@2.28.2`).
   - The API verifies Auth0 JWTs using JWKS caching with automated key rotation, validating `iss`, `aud`, `exp`, `nbf`, and `alg: RS256`.
   - **Local Authority Invariant**: Auth0 claims establish only external identity (`sub`). The local PostgreSQL `memberships` table remains the single authoritative source of truth for `tenant_id`, local `user_id`, `roles`, permissions, and `role_version`. Every consequential command verifies active local membership and rejects revoked users or stale role versions immediately.
   - Exposes OAuth Protected Resource Metadata at `/.well-known/oauth-protected-resource` declaring resource URI, authorization servers, supported bearer methods, and fine-grained scopes (`booking:read`, `booking:quote`, `booking:prepare`, `booking:commit`, `booking:cancel`, `merchant:schedule`, `merchant:refund`).

3. **Two-Phase Human Approval & Zero Autonomous Commit**:
   - AI models and MCP clients are strictly prohibited from committing bookings or authorizing payments autonomously.
   - **Phase 1 (`prepare_booking.v1`)**: Creates a database-backed hold snapshot with GiST exclusion and generates an opaque approval interaction locator (`loc_<hex>`). The server stores a pending confirmation record (`pending_loc_<hex>`). The raw confirmation token is **NEVER** returned to the agent, MCP client, or model context.
   - **Human Out-of-Band Browser Approval**: The human buyer navigates to the hardened approval URL (`/v1/booking-approvals/:locator`), reviews terms and pricing, and explicitly clicks to approve (`POST /v1/booking-approvals/:locator/confirm`), generating a high-entropy 256-bit confirmation token stored hashed in PostgreSQL `buyer_confirmations`.
   - **Phase 2 (`commit_booking.v1`) Data Flow**:
     ```text
     [Autonomous Agent / MCP]         [Buyer Browser]          [VelvetAI API / PostgreSQL]
                |                            |                             |
     1. prepare_booking.v1                   |                             |
        ------------------------------------------------------------------>| (Creates HELD booking
                |                            |                             |  stores pending confirmation)
        <------------------------------------------------------------------| (Returns JWS intent +
          approvalLocator: /v1/approvals/loc_abc                          |  NEVER discloses raw token)
                |                            |                             |
                |-- Agent gives URL to buyer |                             |
                |                            |                             |
                |                    2. GET /v1/approvals/loc_abc          |
                |                       ---------------------------------->| (Displays immutable terms)
                |                    3. Click "Approve & Confirm"          |
                |                       ---------------------------------->| (Generates confirmation token,
                |                       <----------------------------------|  hashes in buyer_confirmations)
                |                            |                             |
     4. commit_booking.v1                    |                             |
        { intent, idempotency_key }          |                             |
        ------------------------------------------------------------------>| 5. Server looks up hold_id
                |                            |                             |    from verified intent claims.
                |                            |                             |    Resolves buyer_confirmations
                |                            |                             |    Fails closed if pending (400)
                |                            |                             |    Fails closed if expired (410)
                |                            |                             |    Fails closed if replayed (409)
        <------------------------------------------------------------------| (Status: COMMITTING)
     ```
   - **Server-Side Resolution Support**: For clean MCP client orchestration, `commit_booking.v1` requires `{ intent, idempotency_key }` with optional `confirmation`. When `confirmation` is omitted by the agent, the server authoritatively resolves the confirmation state by `claims.hold_id` and `tenant_id` from the signed `intent`. If human browser confirmation has not occurred, it fails closed with `APPROVAL_INCOMPLETE` (HTTP 400). If provided, constant-time hash verification is enforced. In both patterns, replay and expiration are cryptographically prevented.

4. **In-Page Ask AI with Google Gemini via Vercel AI SDK**:
   - The in-page assistant is built using Vercel AI SDK (`ai`, `@ai-sdk/google`, `@ai-sdk/react`), with Google Gemini as the production model provider.
   - The backend defines a hexagonal `ModelProviderPort`. In automated testing and local CI, a deterministic `FakeModelProvider` guarantees reproducible, offline test suites.
   - Streaming responses (`POST /v1/ai/chat`) render structured tool cards (pricing, deposit, cancellation policy) separately from model prose.
   - Hardened prompt boundaries isolate untrusted user text; customer notes and raw database credentials are never injected into planner context.
   - Strict budgets are enforced: maximum 20 tool calls per run, 30-second wall-clock timeout, and per-user/per-tenant rate limits.

5. **WebMCP Progressive Enhancement via `document.modelContext`**:
   - In browser environments supporting the modern WebMCP specification, tools are registered using `document.modelContext` (specifically avoiding legacy/deprecated `navigator.modelContext`).
   - Feature-detected gracefully (`if ("modelContext" in document)`). Web application forms and the Ask AI drawer remain fully operational without WebMCP.
   - WebMCP hints (`readOnlyHint`, `consequentialHint`) provide advisory signals to user agents; the backend enforces authoritative authentication and authorization on every call.
   - Bound strictly to same-origin permissions policy.

6. **Deterministic Policy Boundary & Transport Equivalence**:
   - All four access interfaces—REST API, MCP Streamable HTTP, WebMCP, and in-page Ask AI—route through the shared `BookingService` and `ToolRegistry`.
   - Business invariants, GiST slot exclusion, JWS intent signatures, idempotency hashes, and financial journal entries are identical regardless of inbound transport.

## Consequences

- Concurrency and authorization bugs from sessionful MCP implementations are eliminated.
- External Auth0 credentials do not compromise multi-tenant RLS boundaries.
- Models cannot hallucinate or bypass financial commitments; human approval is cryptographically and architecturally mandatory.
- Testing is resilient: unit and abuse scenarios run deterministically offline with the fake model provider, while opt-in E2E tests validate live Gemini and Auth0 integrations.
