# velvetAI Final Week Plan — Full Epic 5 Scope, Two Parallel Tracks (Nov 5 – Nov 12)

For you (the human). Nothing from Epic 5 is cut. The full work packages in `prompts/epic5/02`–`09` are the instructions. This plan adds the schedule, the two-track split, and the per-package kickoff messages.

## Why two tracks

Each work package is about 1–2 days of model work. Eight packages one after another would take about 12 days; we have 7. Two chats working at the same time on separate folders and branches fit the full scope into the time. Your 10 hours a day go to: running both chats, doing dashboard steps, testing on the hosted site, sending reports to the architect, and recording the video.

## Quality guardrails (these protect the win, they don't reduce scope)

1. `main` is always deployable and demo-able. Only VERIFIED packages merge to `main`.
2. Every package is verified on the hosted site after it merges.
3. Devpost draft is created by Nov 9 and updated daily, so submission is never a last-minute risk.
4. Hard deadline for any code change: Wed Nov 11, 11 PM IST. After that, only the submission.
5. If a package is not VERIFIED by its date, it does not merge half-done. The architect decides with you whether to extend it into the buffer.

## Order and dependencies

```text
S0 hygiene ──► P1 parallel setup ──► 01 baseline
                                      │
Track A: 03 Render ──► 04 judge tenant ──► 07 security dashboard ──► 08 judge page + fault injection
Track B: 02 approval & pay ──► 05 Bryntum ──► 06 forecasting ──► 09 Part A polish
                                   ▲            ▲
                         needs 04 merged    needs 04 merged (synthetic history)
Both:    09 Parts B–F (README, Devpost, video, tag, public repo)
```

## Calendar (IST)

| Day        | Track A (folder `velvetAI`)                              | Track B (folder `velvetAI-b`)                                | Your manual tasks                                                                       |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Thu Nov 5  | S0 → P1 → 01                                             | 02 starts once P1 is done (afternoon)                        | rotate Gemini key, Node 24, Docker, approve merges, Auth0 add port 5174                 |
| Fri Nov 6  | 03 Render                                                | 02 finish → merge                                            | Render Blueprint, env values, DB bootstrap, Auth0 hosted URLs + MCP API, PayPal webhook |
| Sat Nov 7  | 04 judge tenant → merge                                  | 05 steps 1–3 using bookings/holds (fixtures after 04 merges) | Auth0 judge user, run provisioning                                                      |
| Sun Nov 8  | 07 security dashboard                                    | 05 finish (fixtures, race test) → merge                      | check Bryntum watermark; review hosted schedule                                         |
| Mon Nov 9  | 08 proof panel + fault injection                         | 06 forecasting                                               | Devpost draft (placeholders); one hosted payment with fault armed                       |
| Tue Nov 10 | 07 + 08 merged and hosted-verified                       | 06 merged; 09 Part A polish                                  | walk the hosted site as judge; list issues                                              |
| Wed Nov 11 | 09 Parts B–E (both chats split docs) — code freeze 11 PM | 09 Part A fixes                                              | rehearse demo, record video, make repo public (owner)                                   |
| Thu Nov 12 | Submit by 6 PM IST                                       | —                                                            | upload video, finish Devpost, submit (deadline Fri 1:30 AM IST)                         |

## How to start a package (kickoff message)

Open a NEW chat in the correct folder for the track. Paste, replacing the placeholders:

```text
You are the velvetAI implementation engineer for TRACK <A or B>.
Working folder: <~/Documents/github/velvetAI or ~/Documents/github/velvetAI-b>
Branch: <feat/epic5-track-a or feat/epic5-track-b>

Read completely before doing anything:
1. @prompts/epic5/00_OPERATING_RULES.md
2. @prompts/epic5/PARALLEL_RULES.md
3. @prompts/epic5/<PACKAGE FILE>
4. @SPEC_V1_1_AMENDMENT.md (Section J)
5. @docs/implementation-progress.md
6. @docs/epic5-checklist.md

Corrections that apply to every package:
- The different-buyer error code is BUYER_MISMATCH (prompts may say APPROVAL_BELONGS_TO_ANOTHER_BUYER).
- The approval page already exists at apps/web/src/pages/ApprovalPage.tsx. Extend it.
- Use the track branch above, not the branch name in 00 section 7 or in any package file.
- Use the calendar dates in FINAL_WEEK_PLAN, not the dates written inside the package files.
- Today is <date>. This package must be VERIFIED by <date from the calendar>.

<PACKAGE-SPECIFIC NOTES FROM FINAL_WEEK_PLAN.md, if any>

Then follow <PACKAGE FILE> exactly:
- Run the git sync first: git fetch origin && git merge origin/main, then the package Preconditions. Report results.
- Give me your plan (files to create/modify) before coding.
- Implement step by step, running narrow tests after each step.
- Stop and give me exact dashboard steps whenever you need Auth0, PayPal, Render, Google, or GitHub. Never ask me for secret values.
- If stuck after two attempts, follow @prompts/epic5/99_FAILURE_RECOVERY.md.
- When VERIFIED, follow PARALLEL_RULES.md step 3 to merge (ask me before pushing main).
- Finish with the report template in 00 section 10.
Do not work on any other package.
```

## Package-specific notes (paste into the kickoff where indicated)

**01 Baseline (Track A, Nov 5):**

- Branch: `feat/epic5-track-a` (not `feat/epic-5-judge-experience` as 01 says; skip 01 task 1).
- Precondition items 2 and 3 (Epic 4 fixes, time zone) are already VERIFIED per the Nov 4 audit; cite the audit instead of re-proving.
- In `docs/submission/DEADLINES.md` use: internal code freeze Wed Nov 11 11 PM IST; submission target Thu Nov 12 6 PM IST.
- Replace the checklist's work package dates with this calendar.

**02 Approval & pay (Track B, Nov 5–6):**

- Migration number 0006 if a migration is needed.
- `PUBLIC_WEB_ORIGIN` locally in track B is `http://localhost:5174`.
- Playwright: use mock auth only in `NODE_ENV=test` for the E2E; do the real Auth0 path manually and after merge on the hosted site.

**03 Render (Track A, Nov 6):**

- Hosted demo seeds the existing development tenant now; WP 04 adds the judge tenant later and the judge user moves there.
- Also create the Auth0 API identifier `https://<api-host>.onrender.com/mcp` and authorize the "velvetAI MCP Agent" M2M app for it.
- After 03 merges, Render auto-deploys `main` on every merge. Confirm auto-deploy is on.

**04 Judge tenant (Track A, Nov 7):**

- Migration number 0007.
- Merge to main as early as possible on Nov 7; track B needs the fixtures and synthetic history.
- Provision the judge tenant and judge user on Render after merge.

**05 Bryntum (Track B, Nov 7–8):**

- Until 04 is merged into main, build Steps 1–3 with the read model returning real bookings and holds only (no fixtures). Do not write placeholder fixture code. After 04 merges, run `git merge origin/main`, then add the DEMO_FIXTURE mapping, its tests, and the race test (judge role from 04).

**06 Forecasting (Track B, Nov 9–10):**

- Migration number 0008.
- Requires 04 (synthetic history) and 05 (schedule read model) in main.

**07 Security dashboard (Track A, Nov 8–10):**

- Migration number 0009.
- The live run L4 and L6 must match the real error codes (`HUMAN_APPROVAL_REQUIRED`, `BUYER_MISMATCH`).
- Part A report JSON: regenerate again in 09 Part D on the final commit.

**08 Judge page + fault injection (Track A, Nov 9–10):**

- Migration number 0010.
- Hosted fault-injection proof on Render is required before VERIFIED.

**09 Submission (both, Nov 10–12):**

- Track B does Part A polish (UI fixes) on Nov 10–11.
- Track A does Parts B, C, D, E on Nov 11 after all merges.
- Part D tag and Part E public repo happen on Nov 11 evening or Nov 12 morning, after the architect reviews the final hosted verification.

## Daily routine for you (10 hours)

1. Morning: start or resume both chats with the kickoff messages. Pull reports from yesterday into the architect chat.
2. During the day: answer the models' stop-and-ask questions, do dashboard steps, keep both chats moving.
3. After each merge: open the hosted site, try the new feature as the judge user, note issues.
4. Evening: send both reports to the architect for review and the next day's corrections.

## After submission

Use `prompts/epic5/10_JUDGING_PERIOD_MAINTENANCE.md` from Nov 12 to Dec 15.
