# Epic 5 · Work Package 09 — Freeze, Polish, and Submission Package

Priority: P0 · Starts Nov 6 (feature freeze) · Finish by Nov 9 · Submit Nov 10 · Read `prompts/epic5/00_OPERATING_RULES.md` first.

## Goal

Everything a judge needs, accurate and verified: a polished hosted demo, a judge-friendly README, Devpost text, judge testing instructions, a video script under 3 minutes, and a tagged submission commit deployed on Render.

From Nov 6 onward: no new features. Only fixes, copy, accessibility, performance, and documentation. Any change still runs the full verification set.

## Devpost requirements (from https://paypalaihackathon.devpost.com/)

- Meaningful use of PayPal and AI, working prototype, documentation.
- Text description of features and functionality.
- Functional demo: hosted URL or complete run instructions (we provide both).
- Tools: identify which AI models/services were used and how.
- Public GitHub repo with all source, assets, run instructions; open-source license visible at the top of the repo (About section).
- Demo video under 3 minutes, public on YouTube, showing the project working, no copyrighted music or third-party trademarks without permission.
- If the site needs login, credentials go in the testing instructions.
- The project must stay available free until judging ends (Dec 15).
- No edits after the deadline (drafts allowed before).

## Part A — Polish pass (Nov 6–7)

Walk every page on the hosted site as (1) a signed-out visitor, (2) the judge account. Fix issues found. Checklist:

- [ ] No engineering jargon on customer pages (search UI strings for: authoritative, invariant, claim, GiST, RLS, tenant, JWS, idempotency).
- [ ] Every money value formatted; no `$0.00` for missing data.
- [ ] Every time shows the merchant zone label; "Your time" where different.
- [ ] Empty, loading, and error states exist on every data view.
- [ ] Keyboard: tab through home, Ask AI, approval page, schedule, security, judge. Focus visible.
- [ ] Contrast: run Lighthouse accessibility on home, approval, schedule; fix anything below 90; report scores.
- [ ] Lighthouse performance on home: report score; lazy-load Bryntum and heavy panels.
- [ ] Mobile width 390 px: home, Ask AI drawer, approval page usable (schedule may say "Best viewed on a larger screen").
- [ ] Browser console: no errors or warnings on any page during the golden path.
- [ ] Favicon, page titles per route, Open Graph image and description for the home page.
- [ ] 404 page for unknown routes.
- [ ] Ask AI: honest provider badge; quota/rate-limit messages friendly.
- [ ] All "demo", "heuristic", "sandbox", "deterministic model", "CI-verified" labels present where required.

## Part B — README rewrite (judge-first)

Structure (keep it scannable; total under ~400 lines):

1. **Title + one-line pitch:** "velvetAI — AI agents can book your appointments, but only you can approve and pay."
2. **Links:** live demo, judge page, video, Devpost, MCP endpoint.
3. **The problem (3 bullets):** no-shows cost local businesses; AI agents can book without real consent; slot hoarding and prompt injection.
4. **What velvetAI does (5 bullets)** tied to the demo path.
5. **Try it in 2 minutes:** numbered steps for judges (sign in with judge account from Devpost testing instructions → /judge → Reset → follow guided path).
6. **How PayPal is used:** Orders v2 intent CAPTURE for deposits, JS SDK v6 one-time payment session, PayPal-Request-Id idempotency, webhook signature verification, partial refunds, capture-status finality, reconciliation of unknown outcomes. Link each to the source file.
7. **How AI is used:** Google Gemini (`gemini-3.5-flash-lite`) via Vercel AI SDK for the in-page concierge with tool calling; MCP 2026-07-28 stateless server for external agents; WebMCP progressive enhancement (simulated unless browser support verified). State exactly what AI can and cannot do.
8. **Security model:** human approval, signed intents, one-time confirmations, GiST exclusion, RLS, append-only ledger, Abuse Lab (N CI scenarios, 12 live checks).
9. **Architecture diagram (Mermaid)** — web, API, worker, PostgreSQL, PayPal, Auth0, Gemini, MCP clients, Render.
10. **Sponsor technologies:** PayPal, Bryntum Scheduler (how it is used: resources, events, assignments, resource time ranges for forecast bands, live updates), Render (static site, web service, worker, PostgreSQL, Blueprint).
11. **Run locally:** under 10 commands from clone to running (mise, pnpm install, docker compose up, migrate, seed, dev). Link `docs/DEPLOYMENT.md` and `docs/testing.md`.
12. **Tests:** counts per package from the final `--force` run; how to run.
13. **Honest limitations:** sandbox only; heuristic forecast on demo data; WebMCP simulated (unless verified); single-region rate limits; Bryntum trial watermark.
14. **License (MIT) and third-party notices.**

Verify every command in "Run locally" from a fresh clone in a temporary directory and report the result.

## Part C — Submission documents

Create under `docs/submission/`:

1. `DEVPOST_SUBMISSION.md` — sections in Devpost order: Inspiration, What it does, How we built it, Challenges we ran into, Accomplishments that we're proud of, What we learned, What's next for velvetAI, Built with (tags: paypal, paypal-js-sdk, orders-v2, webhooks, gemini, vercel-ai-sdk, mcp, react, vite, fastify, typescript, postgresql, bryntum, render, auth0, node.js). Also a 200-character elevator pitch. Every claim must map to evidence in `docs/evidence/`; add an evidence link list at the bottom (not pasted into Devpost).
2. `JUDGE_TESTING.md` — what the user pastes into Devpost's testing instructions field, with placeholders `<JUDGE_EMAIL>`, `<JUDGE_PASSWORD>`, `<PAYPAL_SANDBOX_BUYER_EMAIL>`, `<PAYPAL_SANDBOX_BUYER_PASSWORD>` that the user fills only inside Devpost. Steps: open site → sign in → /judge → reset → guided path; how to pay with sandbox buyer; what to expect for fault injection; MCP connection instructions (the URL and that tokens come from the team on request, or a read-only demo is shown in the video).
3. `VIDEO_SCRIPT.md` — target 2:45, shot list with exact narration and on-screen action:

| Time      | Screen                               | Narration (approx.)                                                                                                                                                                                                         |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | Home                                 | "Local businesses lose money to no-shows, and AI assistants are starting to book for us. Who makes sure the AI doesn't book or pay without you?"                                                                            |
| 0:15–0:45 | Ask AI drawer                        | "I ask velvetAI's concierge, powered by Gemini, for a haircut Saturday afternoon. Real availability from the database, times in the salon's zone. Saturday is high demand, so the deposit is higher — and it tells me why." |
| 0:45–1:10 | Approval page → PayPal Sandbox       | "The AI can only hold the slot. I approve the exact terms myself and pay the deposit with PayPal."                                                                                                                          |
| 1:10–1:25 | Bryntum schedule                     | "The merchant's Bryntum schedule updates live: hold, awaiting deposit, confirmed. Forecast bands show where the week is weak."                                                                                              |
| 1:25–1:55 | /security live run                   | "Now attacks: the AI tries to pay by itself, a prompt injection hides in a note, an agent tries to approve its own booking, twenty bots grab the same slot. All blocked by code, with no state change."                     |
| 1:55–2:25 | /judge fault injection + proof panel | "We make velvetAI lose PayPal's reply. PayPal still captured the money. velvetAI verifies the webhook and reconciles: one payment, one booking, balanced ledger."                                                           |
| 2:25–2:40 | Weak slots / MCP                     | "The forecast finds weak Monday slots; external MCP agents book through the same rules."                                                                                                                                    |
| 2:40–2:50 | Architecture slide                   | "Built on PayPal Orders v2 and JS SDK v6, Gemini, MCP, Bryntum, and Render."                                                                                                                                                |

Include recording tips: 1920×1080, browser zoom 110%, hide bookmarks bar, close notifications, use the judge account, reset demo before recording, no real emails visible, no music or royalty-free music with license noted, captions file (`VIDEO_CAPTIONS.srt`).

4. `SCREENSHOTS.md` — list of 6–8 images for the Devpost gallery with file paths (take them from the hosted site): Ask AI with slots, approval page, PayPal step, confirmed, Bryntum schedule with bands, security live run, proof panel, architecture diagram.

## Part D — Final verification and tag (Nov 9)

1. Regenerate `apps/web/src/data/abuse-lab-report.json` on a clean tree (WP 07 Part A) and commit.
2. Full verification set with `pnpm turbo run test --force`. Report test counts.
3. Merge `feat/epic-5-judge-experience` into `main` (ask the user first). Deploy `main` on Render (Blueprint branch = main).
4. On hosted: run the full golden path, the live security run, the fault injection, and `pnpm mcp:smoke` against the hosted MCP URL. Record results in `docs/evidence/final-hosted-verification.md` with the deployed commit SHA.
5. Tag: `git tag -a devpost-submission-v1 -m "PayPal AI Hackathon submission"` on the deployed commit. Ask the user before pushing tags.
6. Update `docs/submission/DEADLINES.md` with confirmed expiry dates and renewal plans for: Bryntum trial, Render credits/plan, Gemini key quota/billing, Auth0 plan limits, PayPal sandbox app/webhook.

## Part E — Repository visibility (user actions; give exact steps)

1. GitHub → repository → Settings → General → Danger Zone → Change visibility → Public. (Before this, run `git log -p | rg -i "secret|password|api[_-]?key|client_secret"` and a secret scanner such as `gitleaks detect` if available; report findings. If any secret was ever committed, STOP: the user must rotate it and the history must be cleaned before going public.)
2. Repository → About (gear icon) → description, website = hosted URL, topics; confirm the MIT license appears in the About section.
3. Confirm `LICENSE` is at repo root.

## Part F — User submission steps (put this list at the end of your report)

1. Record the video following VIDEO_SCRIPT.md. Upload to YouTube as Public. Check it's under 3:00.
2. On Devpost: create the project (draft) by Nov 8, paste DEVPOST_SUBMISSION.md sections, add the YouTube link, GitHub link, hosted URL, gallery images, and the testing instructions with real credentials typed directly into Devpost.
3. Select the hackathon and opt into the relevant prize categories.
4. Submit by Nov 10. Confirm the submission shows as submitted on Devpost.

## Definition of done

- [ ] Polish checklist complete with Lighthouse scores reported.
- [ ] README verified from a fresh clone.
- [ ] Submission docs complete and evidence-linked.
- [ ] Final hosted verification evidenced at the tagged commit.
- [ ] Secret scan clean; repo ready to be public.
- [ ] Deadlines document complete.
