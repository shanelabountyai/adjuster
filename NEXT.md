# NEXT

## ▶ Next session: task 1.2 is Shane's (by hand), then 1.7

**2026-10-02 (later):** 1.6 done: `src/rules/canonical.ts` (`canonicalJson`, `sha256Hex`), D28 applied (`factDictionaryHash` in plan/ops, checked by `rules:lint`). `npm test` 200 pass. `docs/trace-by-hand.md` still empty. 1.7 (condition evaluator) does not depend on the trace shape for its cell results, so it can start before 1.2 lands. **Shane said go (2026-10-02): next session builds 1.7 now; 1.2 can reshape the trace later.**

**2026-10-02:** Shane is doing 1.2 now; skeleton at `docs/trace-by-hand.md` (facts only, no answers). When it's filled in: compare it to the fixtures' trace shape, adjust `src/rules/schema.ts` + regenerate if they differ, then 1.6. Start sessions in `~/Projects/adjuster`, not `adjuster-kickoff`.

**Update 2026-10-02:** review answered (decisions D23–D29, recommended options). D25 (F5 upper bound) and D26 (`ratio_exceeds_bps`, PAY-I) applied; fixtures now 23 RE, 9 PAY, 10 GC. Still open: P1–P6 and review items 5–10, 13, 14, 16, 18–20, 22 (provisional, none moves GC-01..10). D28 (dictionary hash in the envelope) lands with 1.6.

Setup and phase 1 tasks 1.1, 1.3, 1.4, 1.5 are done and pushed (2026-10-01, repo `shanelabountyai/adjuster`, private).

1. **Read `docs/phase-1-review.md` and answer it.** Nothing in it is resolved. Items 1 (decisions file stops at D22, not D30), 3 (D19 vs the brief on claimant text), 4 (F5 vs GC-13) and 11 (ratio_bps rounding vs "C > 70% of R") change fixtures or rule data. `docs/decisions.md` → *Proposed* holds P1–P6, the vocabulary the rule data already uses.
2. **Task 1.2 (Shane):** adjudicate GC-01, GC-04, GC-08 on paper from `docs/domain-brief.md` alone; check in `docs/trace-by-hand.md`. The fixtures' trace shape (`adjuster.trace/0`) is provisional until then; if the page differs, change `src/rules/schema.ts` and regenerate.
3. **Then 1.7** (condition evaluator, three-valued). 1.6 is done.

State: `npm run rules:lint` ok · `npm run fixtures:check` OK (23 RE, 8 PAY, 10 GC) · `npm test` 200 pass · `decisions:verify` exits 1 on purpose until 1.11.
Model: Opus 5.5 (pinned in `.claude/settings.json`).
Template `CLONES.md` row added in `~/Projects/saas foundation` (uncommitted there, alongside boxloop's uncommitted row).
