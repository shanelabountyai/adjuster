# NEXT

## Document Intake: contract check settled (2026-10-14). Start phase 1.

Decisions A–I are D90 in `docs/decisions.md`; the check is `docs/intake-contract-check.md`. Phase 1 (label set, no model calls) kickoff is in `docs/prd-intake.md`, "Phase 1: label set". Plan first, wait for approval, then build. Before phase 1 builds anything: add the CLAUDE.md "Intake module" section (reworded to the repo's terms: bps not floats, `intake/` data, D90).

Phase 4 is closed; gate at closure: 563 tests, `decisions:verify` OK (67), `fixtures:check` OK (104), `rules:lint` OK. Closure URLs in `docs/RELEASE_NOTES.md`.

**Known, not fixed:** one full-suite run had `decisions-verify`'s reseed blocked by a connection `idle in transaction` on `Claim` (`rulesFor`, `src/adjudication/documents.ts:110`). Did not recur. If it does: `SELECT pid, state, query FROM pg_stat_activity WHERE datname='adjuster_test'` mid-run.
