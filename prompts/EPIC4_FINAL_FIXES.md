# velvetAI Epic 4 Final Fixes Prompt

Act as the velvetAI security auditor and Epic 4 finisher.

CURRENT PHASE

Epic 4 was marked ACCEPTED at commit 0e28782. Review of the closeout report found one possible critical security gap, one MCP interoperability defect, three evidence gaps, and one misleading error code. Fix them, then run the time zone/UX prompt. Do not start Epic 5. Do not install Bryntum.

Execute in order: F1, F2, F3, F4, then @prompts/EPIC4_ASK_AI_TIMEZONE_UX_FIX.md (T1–T6 and VERIFICATION).

==================================================
F1 — CRITICAL: CAN AN AGENT APPROVE ITS OWN HOLD?
==================================================

The two-phase protocol is only meaningful if the party that receives the approval locator (the agent) cannot complete approval itself.

Evidence of risk:

- docs/EPIC4_WEBSITE_STATUS.md lists the approval surface auth requirement as "Public locator".
- `pnpm mcp:smoke --auto-approve` obtained a one-time confirmation token without a human.

Answer with code citations:

1. Which credential did --auto-approve use to call POST /v1/booking-approvals/:locator/confirm? The M2M token, no token, a dev/test token, or a direct database/service call?
2. What authentication does the confirm route require today?

Required invariant (amendment intent/confirmation separation):

- POST /v1/booking-approvals/:locator/confirm requires an authenticated HUMAN buyer session: an Auth0 user access token (sub not ending in "@clients", no client-credentials grant) mapped to a local app_users row with buyer membership in the hold's tenant.
- The approving buyer must be the buyer the hold was prepared for (or the authenticated buyer on whose behalf the agent acted, as recorded at prepare time). Buyer B with Buyer A's locator fails closed.
- M2M/agent tokens, missing tokens, and dev tokens (outside NODE_ENV=test) receive 401/403 with a specific code (for example HUMAN_APPROVAL_REQUIRED). Zero state change.
- GET on the locator remains read-only terms inspection.

If the route is currently public or accepts the M2M token, this is a critical defect: fix it before anything else.

Then:

1. `--auto-approve` must only work against NODE_ENV=test with an in-process test buyer identity, or be removed. Against the dev server, the smoke script always pauses for a human.
2. Add Abuse Lab scenarios (Critical severity, deterministic):
   - "Agent approves its own hold with its M2M token" -> 403, no confirmation issued.
   - "Unauthenticated request confirms locator" -> 401, no confirmation issued.
   - "Buyer B confirms Buyer A's locator" -> 403, no confirmation issued.
3. Re-run `pnpm mcp:smoke` with a real human approval. Add a minimal web page at /approve/:locator (signed-in buyer sees the terms and an Approve button; Epic 5 W1 will polish it). The smoke script prints the web URL, the user signs in as the test buyer and clicks Approve, then the script continues. Do not ask the user to copy tokens out of the browser.
4. Correct docs/EPIC4_WEBSITE_STATUS.md auth requirement for the approval surface.

==================================================
F2 — MCP PROTECTED RESOURCE METADATA MUST MATCH THE MCP URL
==================================================

MCP Inspector 2.12.0 rejected the server: "Protected resource https://velvetai.example/api does not match expected http://localhost:3000/mcp". This is a server configuration defect, not strict-client behavior. RFC 9728 and the MCP 2026-07-28 authorization spec require the resource identifier in the metadata to match the MCP server URL the client connected to, and tokens for the MCP server must have that resource as audience (no token passthrough to other audiences).

Fix:

1. Configure MCP_RESOURCE_URL (local: http://localhost:3000/mcp; hosted later: https://<render-api-host>/mcp).
2. Serve path-specific metadata at /.well-known/oauth-protected-resource/mcp with resource = MCP_RESOURCE_URL, authorization_servers = [AUTH0_ISSUER], supported scopes for agent tools. 401 responses from /mcp point WWW-Authenticate resource_metadata at that path-specific URL. Keep the existing root metadata for the REST API audience.
3. /mcp accepts only tokens whose aud includes MCP_RESOURCE_URL. REST routes keep accepting the existing API audience. Do not accept MCP-audience tokens on REST routes or vice versa unless documented and tested.
4. Give the user exact Auth0 steps: create a second API "velvetAI MCP" with identifier http://localhost:3000/mcp, RS256, same scopes needed by agents; authorize the "velvetAI MCP Agent" M2M app for it with booking:read, booking:quote, booking:prepare, booking:commit. Note that Render needs another identifier later (Epic 5 W2).
5. Re-run MCP Inspector (CLI tools/list, then a list_services.v1 call) and `pnpm mcp:smoke`. Record client versions and output in docs/evidence/mcp-external-client.md.
6. Tests: wrong-audience token on /mcp -> 401; MCP-audience token on REST -> 401/403; metadata resource equals MCP_RESOURCE_URL.

==================================================
F3 — EVIDENCE GAPS FROM THE CLOSEOUT REPORT
==================================================

1. Forced test runs: "Run 2 (cached) 0.12s" was a Turborepo cache hit, so no tests ran. Run `pnpm turbo run test --force` three consecutive times and report each duration and test count.
2. Test credentials: committed config uses postgres:postgres@localhost:5432. Epic 3.5 established zero fixed passwords. Derive the test connection from POSTGRES_USER/POSTGRES_PASSWORD (or a TEST_DATABASE_ADMIN_URL in .env.test that is gitignored, with .env.test.example committed). Re-run `git grep -nE "postgres:postgres|velvet_runtime_pass|velvet_dev_pass"` and report zero hits outside docs that explain the rule.
3. AI SDK step limit: quote apps/api/src/routes/ai.ts around the streamText call. In AI SDK 7, multi-step tool loops are controlled by stopWhen (for example stepCountIs(5)); a maxSteps option passed to streamText is not the control. If maxSteps is only a local constant feeding stopWhen, say so. Otherwise fix it and add a test proving a 3-step tool loop completes.

==================================================
F4 — SPECIFIC ERROR FOR "NOT APPROVED YET"
==================================================

Smoke step e returned "Invalid buyer confirmation token or confirmation does not match booking hold" when the human simply had not approved yet. Earlier docs claim APPROVAL_INCOMPLETE exists.

1. When commit_booking.v1 omits confirmation and the hold's approval is still pending, return code APPROVAL_INCOMPLETE with a safe message ("The buyer has not approved this booking yet. Ask them to open the approval link."), plus approval expiry. Keep the generic invalid-token error for real mismatches.
2. The same code across REST, MCP, and Ask AI. Extend the transport equivalence suite.
3. Ask AI: on APPROVAL_INCOMPLETE, the assistant tells the user to open the approval link, and never retries commit.

==================================================
REPORT FORMAT
==================================================

1. F1: answers to both questions with code citations, whether a defect existed, the fix, new Abuse Lab scenarios, and the human-approved smoke output.
2. F2: metadata before/after, Auth0 steps given to the user, Inspector output, tests.
3. F3: three forced test durations and counts, credential grep output, ai.ts step-limit quote.
4. F4: error contract and tests.
5. Then the full REPORT FORMAT from EPIC4_ASK_AI_TIMEZONE_UX_FIX.md.
6. Command table (format:check, lint, typecheck, test --force, build, git diff --check) and commit SHAs.

Never print secrets, tokens, raw or partial confirmation tokens, or PII.
