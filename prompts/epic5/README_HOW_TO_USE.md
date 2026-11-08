# How to use the Epic 5 prompt pack

This folder is for you (the human). The other files are the prompts for the coding model.

This pack replaces the earlier single-file `prompts/EPIC5_JUDGE_EXPERIENCE_PROMPT.md`. If you saved that file in the repo, delete it so the model doesn't follow two plans:

```zsh
git rm -f prompts/EPIC5_JUDGE_EXPERIENCE_PROMPT.md 2>/dev/null || rm -f prompts/EPIC5_JUDGE_EXPERIENCE_PROMPT.md
```

## 1. Save the files into the repo (once)

On your MacBook:

```zsh
cd ~/Documents/github/velvetAI
mkdir -p prompts/epic5
```

For each file below, run `nano prompts/epic5/<FILE NAME>`, paste the whole file content, then Ctrl+O, Enter, Ctrl+X.

| File                                         | Purpose                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `00_OPERATING_RULES.md`                      | Shared rules, invariants, workflow, report template (read by every package) |
| `01_BASELINE_AND_PLAN.md`                    | Clean baseline, ADR 0008, checklist, deadlines doc                          |
| `02_APPROVAL_PAGE_AND_GOLDEN_PATH.md`        | Buyer approval page, AI → human → PayPal flow                               |
| `03_RENDER_DEPLOYMENT.md`                    | Hosted deployment, stable webhook, Gemini rate limits                       |
| `04_JUDGE_TENANT_SEED_AND_RESET.md`          | Judge tenant, deterministic demo data, reset                                |
| `05_BRYNTUM_SCHEDULER.md`                    | Bryntum live schedule, race demo                                            |
| `06_FORECASTING_AND_DEPOSITS.md`             | Fill forecast, weak slots, deposit by demand, no-show risk                  |
| `07_ABUSE_LAB_DASHBOARD.md`                  | /security page with CI and live attack checks                               |
| `08_JUDGE_PAGE_PROOF_AND_FAULT_INJECTION.md` | /judge page, proof panel, lost-payment recovery demo                        |
| `09_SUBMISSION_PACKAGE.md`                   | Freeze, polish, README, Devpost text, video script, tag                     |
| `10_JUDGING_PERIOD_MAINTENANCE.md`           | Keep the demo alive until Dec 15                                            |
| `99_FAILURE_RECOVERY.md`                     | Use when the model is stuck                                                 |

Then commit them:

```zsh
git add prompts/epic5
git commit -m "docs(prompts): add Epic 5 work package prompts"
```

## 2. Order and calendar

Do not start 01 until `EPIC4_FINAL_FIXES.md` (F1–F4) and the time zone fix are both reported VERIFIED.

| Dates         | Package               | You must do (dashboards, approvals)                                                                            |
| ------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Oct 27        | 01 Baseline           | nothing                                                                                                        |
| Oct 27–29     | 02 Approval page      | sign in and approve during manual tests; PayPal sandbox buyer payment                                          |
| Oct 29–31     | 03 Render             | Render Blueprint, enter env values, run DB bootstrap, Auth0 URLs, new Auth0 MCP API identifier, PayPal webhook |
| Oct 31–Nov 1  | 04 Judge tenant       | create Auth0 judge user, run provisioning command                                                              |
| Nov 1–3       | 05 Bryntum            | nothing (check the watermark shows)                                                                            |
| Nov 3–4       | 06 Forecasting        | nothing                                                                                                        |
| Nov 4–5       | 07 Security page      | nothing                                                                                                        |
| Nov 5–6       | 08 Judge page         | one hosted sandbox payment with fault armed                                                                    |
| **Nov 6**     | **Feature freeze**    |                                                                                                                |
| Nov 6–9       | 09 Submission         | record video, make repo public, Devpost draft by Nov 8                                                         |
| **Nov 10**    | **Submit on Devpost** |                                                                                                                |
| Nov 10–Dec 15 | 10 Maintenance        | twice-weekly 10-minute check                                                                                   |

If a package runs late, the model's report says what it will cut. Approve cuts only from that package's "Cut list".

## 3. Kickoff message for each package

Start a **new chat** for each package (fresh context works better for smaller models). Paste:

```text
Read these files completely before doing anything:
1. @prompts/epic5/00_OPERATING_RULES.md
2. @prompts/epic5/<PACKAGE FILE>
3. @SPEC_V1_1_AMENDMENT.md (Section J)
4. @docs/implementation-progress.md
5. @docs/epic5-checklist.md (skip for package 01; it creates it)

Then follow <PACKAGE FILE> exactly:
- First run the Preconditions and report results.
- Then give me your plan (files to create/modify) before coding.
- Implement step by step, running narrow tests after each step.
- Stop and give me exact dashboard steps whenever you need Auth0, PayPal, Render, Google, or GitHub actions. Never ask me for secret values.
- If stuck after two attempts, follow @prompts/epic5/99_FAILURE_RECOVERY.md.
- Finish with the report template from 00 section 10.
Do not work on any other package.
```

Replace `<PACKAGE FILE>` with, for example, `02_APPROVAL_PAGE_AND_GOLDEN_PATH.md`.

## 4. After each package

Paste the model's final report into the architect chat for review before starting the next package. Things to check yourself in the report:

- Status is VERIFIED (not IMPLEMENTED).
- The test row says `pnpm turbo run test --force` with a test count and a duration longer than a few seconds.
- There is a full commit SHA and `git status --short` is clean.
- No secrets, tokens, or `conf_` strings appear anywhere in the report.

## 5. If the model drifts

Paste:

```text
Stop. Re-read @prompts/epic5/00_OPERATING_RULES.md and @prompts/epic5/<PACKAGE FILE>.
List which steps of the package are done, which are not, and anything you did that is outside the package.
Revert anything outside the package, then continue from the first unfinished step.
```
