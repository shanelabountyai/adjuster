# NEXT

## Document Intake phase 1: built; waiting on Shane's hand labeling (2026-10-14)

Built (D91; CLAUDE.md "Intake module"): `intake/electronics/schemas-v1.json` (linted), `eval/generate.ts` (120 files, 60/60 `eval/split.json`), `eval/labels.ts` (`loadSignedLabels`, the only reader), `eval/signoff.ts` (port 4901). How-to: `eval/README.md`.

**Shane's step, before phase 2 can start:**
1. Print the 15 files in `eval/print/`, photograph each one, and save the photos as `eval/photos/<id>.jpg`.
2. `npm run eval:signoff`, then sign all 120 labels. Commit `eval/labels/` and `eval/photos/`.

Phase 2 (normalizers and validators, TDD from the signed labels) starts when `loadSignedLabels()` returns 120 labels. The kickoff is in `docs/prd-intake.md`, "Phase 2". Show the edge-case list before implementing.

Gate at the end of phase 1: typecheck, lint and `rules:lint` OK; `npm test` 565/570. The 5 failures are all in `decisions-verify.test.ts`, are hook timeouts, and the file passes 21/21 on its own (see below).

**Known, not fixed, and it RECURRED on 2026-10-14:** in a full-suite run, the reseed in `decisions-verify` hangs (hook timeout, then `current transaction is aborted`). The suspect from the earlier run is an `idle in transaction` connection on `Claim` (`rulesFor`, `src/adjudication/documents.ts:110`). That has not been confirmed: nobody queried the database mid-run. Next time, mid-run: `SELECT pid, state, query FROM pg_stat_activity WHERE datname='adjuster_test'`. Worth its own item before CI depends on it.

Phase 4 closure URLs are in `docs/RELEASE_NOTES.md`.
