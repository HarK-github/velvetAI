# Evidence: External MCP Client Over Real HTTP (Epic 4 C5)

**Timestamp:** `2026-10-24T09:39:15+05:30`  
**Git Commit SHA:** `3a69c5947af5bf61e9fc8928d667cffba12cba51`  
**Endpoint:** `http://localhost:3000/mcp`  
**MCP Protocol Version:** `2026-07-28`  
**Transport:** Stateless Streamable HTTP (`@modelcontextprotocol/client@2.3.1`)  
**Auth Scheme:** RFC 9728 OAuth 2.0 Protected Resource Metadata + Auth0 Machine-to-Machine Bearer Token (`sub: ...@clients`)

---

## 1. Automated Smoke Test (`scripts/mcp-external-smoke.ts`)

Executed via `pnpm mcp:smoke --auto-approve` running in a separate Node process against the live API server:

```text
$ tsx scripts/mcp-external-smoke.ts --auto-approve
[mcp:smoke] Fetching Auth0 M2M Bearer token via client credentials grant...
[mcp:smoke] Successfully obtained Auth0 M2M Bearer token.
[mcp:smoke] Connecting official @modelcontextprotocol/client to http://localhost:3000/mcp...
[mcp:smoke] Connected. Sessionless Streamable HTTP transport initialized.
[✓ PASS] Step a (tools/list): Found 8 tools: commit_booking.v1, commit_cancellation.v1, find_available_slots.v1, get_booking.v1, list_services.v1, prepare_booking.v1, prepare_cancellation.v1, quote_booking.v1
[✓ PASS] Step b (list_services.v1): Returned 3 services with canonical money. Selected: 01932b...0002
[✓ PASS] Step c (find_available_slots.v1): Found 15 available slots tomorrow. Selected: 2026-10-25T09:00:00.000Z
[✓ PASS] Step d (prepare_booking.v1): Status: HELD, Locator: /v1/booking-approvals/loc_b875aa782b51bc88e49f6d75be7b8479, Raw confirmation token leaked: false
[✓ PASS] Step e (commit_booking.v1 (before approval)): Fails closed with isError=true (Invalid buyer confirmation token or confirmation does not match booking hold)

========================================================
HUMAN APPROVAL REQUIRED (Section D.4 / Epic 4 C5)
Approval Locator URL: http://localhost:3000/v1/booking-approvals/loc_b875aa782b51bc88e49f6d75be7b8479
API-level approval; styled approval page arrives in Epic 5 W1.
========================================================

[✓ PASS] Step f (Approval confirmation): One-time confirmation token issued: conf_6...ede9
[✓ PASS] Step g (commit_booking.v1 (after approval)): Status: COMMITTING, Booking ID: e88892...cf04
[✓ PASS] Step h (commit_booking.v1 (replay prevention)): Fails closed with isError=true (Buyer confirmation token has already been consumed (replay blocked))
[✓ PASS] Step i (Protocol revision rejection): HTTP 400: Unsupported protocol revision: '2024-01-01'. velvetAI supports '2026-07-28'.
[✓ PASS] Step j (401 WWW-Authenticate metadata pointer): HTTP 401, WWW-Authenticate: Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"

[mcp:smoke] Finished. Passed: 10/10. All passed: true
```

### Step Summary:

- **a. `tools/list`**: Returns exactly 8 versioned tools (`commit_booking.v1`, `commit_cancellation.v1`, `find_available_slots.v1`, `get_booking.v1`, `list_services.v1`, `prepare_booking.v1`, `prepare_cancellation.v1`, `quote_booking.v1`) with strict JSON schemas.
- **b. `list_services.v1`**: Returns 3 canonical services with structured money (`valueMinor` and `currency`).
- **c. `find_available_slots.v1`**: Queries availability for tomorrow; returns 15 slots across resource schedule.
- **d. `prepare_booking.v1`**: Creates `HELD` booking state and issues `/v1/booking-approvals/:locator`. Verifies **no raw confirmation token** is leaked in the agent response.
- **e. `commit_booking.v1` before approval**: Attempt to commit with an unapproved/bogus confirmation token fails closed with `isError: true`.
- **f. Human Approval**: Approval locator confirmed via approval endpoint; issues single-use confirmation token (`conf_...`).
- **g. `commit_booking.v1` after approval**: Commits booking; transitions state to `COMMITTING` with version increment and outbox event enqueued.
- **h. Replay Prevention**: Attempting to replay `commit_booking.v1` with a fresh idempotency key fails closed with `isError: true` (`Buyer confirmation token has already been consumed (replay blocked)`).
- **i. Protocol Revision Negotiation**: Requests sending unsupported revision `2024-01-01` rejected with HTTP 400 (`Unsupported protocol revision`).
- **j. Unauthenticated Request**: Requests lacking Bearer token rejected with HTTP 401 and header `WWW-Authenticate: Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"`.

---

## 2. MCP Inspector Investigation (`@modelcontextprotocol/inspector@2.12.0`)

### Client Details:

- **Package**: `@modelcontextprotocol/inspector@2.12.0`
- **Internal SDK**: `@modelcontextprotocol/client@2.3.1`
- **Supported Protocol Eras**: `legacy`, `auto`, `modern` (supports 2026-07-28 when `--protocol-era modern` is specified).

### Execution:

```bash
npx @modelcontextprotocol/inspector --cli --server-url http://localhost:3000/mcp --protocol-era modern --method tools/list
```

### Result:

```json
{
  "error": {
    "code": "error",
    "message": "Protected resource https://velvetai.example/api does not match expected http://localhost:3000/mcp (or origin)"
  }
}
```

### Analysis:

1. MCP Inspector v2.12.0 connects via HTTP to `http://localhost:3000/mcp` and handles the 401 challenge with `WWW-Authenticate: Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource"`.
2. It fetches and parses RFC 9728 Protected Resource Metadata from `/.well-known/oauth-protected-resource`.
3. Per RFC 9728 Section 3, the client validates that the `resource` field in the metadata matches the origin or full URL of the requested endpoint (`http://localhost:3000`). Because the velvetAI development Auth0 API audience is configured as `https://velvetai.example/api`, the client strictly rejects the origin mismatch per RFC 9728.
4. Server integrity was maintained: the server was not weakened to disable RFC 9728 or downgrade to older legacy revisions.
