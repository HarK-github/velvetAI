Act as a Principal Software Architect, Payment Systems Auditor, Security Reviewer, and Technical Program Manager.

Your task is to inspect the current velvetAI repository and produce a precise, evidence-backed implementation status dossier that another architect—who cannot access the repository—can use to direct all remaining work.

THIS IS A READ-ONLY AUDIT

Do not:

- Modify application source code.
- Modify migrations or schemas.
- Change tests.
- Install or remove dependencies.
- Reformat files.
- Delete duplicates.
- Commit, stage, push, merge, rebase, or switch branches.
- Call PayPal APIs.
- Trigger sandbox payments or refunds.
- Start tunnels or modify webhooks.
- Expose secrets, credentials, complete sandbox IDs, buyer information, or raw webhook bodies.

The only file you may create or update is:

docs/PROJECT_STATUS_DOSSIER.md

If this file already exists, replace its generated status sections while preserving any clearly marked human-authored notes.

==================================================
FILES TO READ FIRST
==================================================

Read completely:

1. @spec.md
2. @SPEC_V1_1_AMENDMENT.md
3. @docs/implementation-progress.md
4. All ADRs under @docs/decisions/
5. @README.md
6. All prompts under @prompts/
7. Root package.json, pnpm-workspace.yaml, turbo.json and mise.toml
8. All database migrations
9. API route registration and application bootstrap
10. Domain/application services and ports
11. PayPal adapter and payment service
12. Worker/outbox implementation
13. Tool registry
14. Forecasting package
15. Web application routes/components
16. Abuse Lab scenarios and tests
17. Deployment/Render/Docker configuration

Treat progress documents as claims to verify—not as proof.

SPEC_V1_1_AMENDMENT.md supersedes conflicting requirements in spec.md.

==================================================
STATUS VOCABULARY
==================================================

Use only these implementation statuses:

- ABSENT: No implementation found.
- DOCUMENTED_ONLY: Described in docs but no implementation found.
- SCAFFOLDED: Interface, placeholder, feature flag, or incomplete shell exists.
- IMPLEMENTED_UNVERIFIED: Substantive code exists but no passing verification evidence.
- AUTOMATED_VERIFIED: Relevant automated tests/checks pass.
- REAL_E2E_VERIFIED: Verified against the real external sandbox/service.
- DEPLOYED_VERIFIED: Running on a stable public environment and manually verified.
- BLOCKED: Cannot proceed because of a documented dependency or missing access.
- DEFERRED: Explicitly out of current scope.
- FAILED: Implemented or tested but currently failing.

Do not use “complete,” “done,” or “verified” without choosing the exact status above.

For every status, include:

- Confidence: HIGH, MEDIUM, or LOW.
- Implementation evidence.
- Verification evidence.
- Remaining gap.

==================================================
AUDIT METHOD
==================================================

1. Inspect Git state and repository structure.
2. Map specification requirements to actual symbols/files.
3. Trace workflows end to end through routes, services, database transactions, workers, external adapters and UI.
4. Inspect tests to determine what they genuinely assert.
5. Run non-destructive local verification commands.
6. Compare code behavior with documentation claims.
7. Identify contradictions, dead code, duplicate sources of truth and misleading status labels.
8. Produce docs/PROJECT_STATUS_DOSSIER.md.
9. Print a concise handoff summary in chat.

Do not fix findings during this audit.

==================================================
SAFE COMMANDS TO RUN
==================================================

Run and record exact output or a faithful concise summary:

git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short
git log -10 --oneline --decorate
git diff --check
pnpm --version
node --version
pnpm list --depth -1 -r
pnpm lint
pnpm typecheck
pnpm test
pnpm build

If a command fails:

- Preserve the exact exit code.
- Include the relevant failure output.
- Continue with independent audit work where safe.
- Do not change code to make it pass.

Do not run the real PayPal Sandbox E2E flow.

You may inspect its recorded sanitized evidence and supporting implementation.

==================================================
REQUIRED DOSSIER STRUCTURE
==================================================

Create:

docs/PROJECT_STATUS_DOSSIER.md

Use the following exact sections.

# velvetAI Repository Status Dossier

## 1. Audit Metadata

Include:

- Audit timestamp in UTC.
- Branch.
- Full commit SHA.
- Short commit SHA.
- Working-tree status.
- Node version.
- pnpm version.
- PostgreSQL version used by tests, if provable.
- Specification sources and precedence.
- Auditor limitation: repository inspection only; no new PayPal calls.

## 2. Executive Status

Answer explicitly:

1. Is the backend foundation ready?
2. Is concurrency-safe booking ready?
3. Is automated PayPal integration ready?
4. Has real PayPal Sandbox E2E been evidenced?
5. Is the customer website locally functional?
6. Is the website stably hosted?
7. Are MCP tools functional?
8. Is WebMCP functional?
9. Is in-page Ask AI functional?
10. Is Bryntum functional?
11. Are forecasts visible in the product?
12. Is Judge Mode functional?
13. Is the project hackathon-demo ready?
14. Is the project Devpost-submission ready?
15. Is the project production ready?

Use the exact status vocabulary for each answer.

Provide one honest overall statement:

```text
Engineering epics completed: X of 5
Hackathon submission readiness: STATUS
Primary current blocker: ...
Recommended next epic: ...
```
