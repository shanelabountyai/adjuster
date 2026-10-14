# NEXT

## Phase 4 is closed (2026-10-14). Nothing is queued.

All 14 tasks are done. Gate at closure: 51 test files pass (563 tests), `decisions:verify` OK (67), `fixtures:check` OK (104), `rules:lint` OK. Closure deliverables and their URLs are in `docs/RELEASE_NOTES.md` (demo script, exec brief, Ledger posts 123 and 124, cost review).

**Next, when Shane opens it:** Document Intake (`docs/prd-intake.md`). Its first session is the read-only contract check at the end of that file. Do not build any of it before then.

**Known, not fixed:** one full-suite run had `decisions-verify`'s reseed blocked past the hook limit by a connection left `idle in transaction` on `Claim` (the query from `rulesFor`, `src/adjudication/documents.ts:110`). It did not recur. If it comes back, run `SELECT pid, state, query FROM pg_stat_activity WHERE datname='adjuster_test'` mid-run.

**Open edges** (a claim page with no list to reach it; the carried lifecycle items) are listed in `docs/DEMO.md` and `docs/phase-4-tasks.md`, "Carried in".
