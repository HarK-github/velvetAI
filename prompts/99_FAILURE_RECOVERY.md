# Epic 5 · Failure Recovery Prompt (use whenever a work package gets stuck)

Read `prompts/epic5/00_OPERATING_RULES.md` first.

You are stuck or something is failing. Do not keep trying random fixes. Follow these steps exactly.

## Step 1 — Stop and capture

Report:

1. The work package and step you were on.
2. The exact command you ran.
3. The full error output (trim only repeated lines; remove secrets).
4. `git status --short` and `git diff --stat`.
5. What changed since the last time the full verification set passed (list files).

## Step 2 — Classify

Pick one:

- **A. Test failure in code you just changed.** Read the failing assertion. Decide whether the code is wrong or the test expectation is wrong. The test is only wrong if the requirement in the work package says otherwise; quote that requirement.
- **B. Test failure in code you did not change.** Probably shared state (database, time, ports) or a dependency change. Run that package's tests alone with `--force`. Check per-package test database names. Check for missing `pnpm db:test:prepare` after a migration.
- **C. Type error.** Read the full error. Fix the type at its source; never add `any`, `@ts-ignore`, or casts to silence it.
- **D. Lint/format.** Run `pnpm format` (if the repo has it) and fix lint by changing code, not by disabling rules.
- **E. Third-party API or package behaves differently** (Bryntum, Render, PayPal, Auth0, AI SDK, MCP SDK). Open the official docs for the installed version. Quote the relevant lines with the URL. Adjust code to the docs.
- **F. Environment/dashboard problem** (missing env var, wrong callback URL, webhook not delivered). Write exact steps for the user to check or fix. Never ask for secret values.
- **G. Design conflict** (a requirement seems to break an invariant from 00 section 4). Stop and ask the user, explaining both sides in plain words.

## Step 3 — One hypothesis, one change

State one hypothesis, make the smallest change that tests it, run the narrowest test. If it fails, revert that change before trying the next hypothesis. After two failed hypotheses, stop and report to the user with both hypotheses and outputs.

## Step 4 — Return to the work package

When fixed, run the full verification set, then continue the work package from where you stopped. Mention the recovery in the work package report under "Honest gaps / labels" if anything was cut or changed.

## Never

- Delete, skip, or weaken tests.
- Disable RLS, GiST, idempotency, signature checks, or auth to make something work.
- Switch PayPal to live.
- Commit secrets or print tokens.
- Mark a work package VERIFIED with any failing check.
