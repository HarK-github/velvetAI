# Parallel track rules

1. Each track only edits files for its own work packages. Shared files (route registration, idempotency route list, tool registry, error code enum, contracts index, docs/implementation-progress.md, docs/epic5-checklist.md) may be edited by both: keep edits small and additive (append, don't reorder).
2. Migration numbers are reserved:
   - 0006 — WP 02 approval (track B, only if needed)
   - 0007 — WP 04 judge tenant (track A)
   - 0008 — WP 06 forecasting (track B)
   - 0009 — WP 07 abuse runs (track A)
   - 0010 — WP 08 fault flags (track A)
     If a reserved migration isn't needed, leave the number unused.
3. Integration after every VERIFIED work package:
   a. In the track folder: `git fetch origin && git merge origin/main` (merge, not rebase). Resolve conflicts keeping BOTH sides' additions. Run the full verification set.
   b. Ask the user before: `git switch main && git pull --ff-only && git merge --no-ff feat/epic5-track-x && git push origin main`, then switch back to the track branch.
   c. Render deploys main automatically (after WP 03). Verify the hosted site after each merge.
4. Never force-push. Never rebase a pushed branch.
5. Pull main into your track at least once per day even without finishing a package.
6. Only track A runs `pnpm mcp:smoke` and hosted PayPal tests; track B tests PayPal locally.

