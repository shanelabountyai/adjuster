# NEXT

## Document Intake phase 1: built; waiting on Shane's hand labeling (2026-10-14)

Built (D91; CLAUDE.md "Intake module"): `intake/electronics/schemas-v1.json` (linted), `eval/generate.ts` (120 files, 60/60 `eval/split.json`), `eval/labels.ts` (`loadSignedLabels`, the only reader), `eval/signoff.ts` (port 4901). How-to: `eval/README.md`.

**Shane's step, before phase 2 can start:**
1. Print the 15 files in `eval/print/`, photograph each one, and save the photos as `eval/photos/<id>.jpg`.
2. `npm run eval:signoff`, then sign all 120 labels. Commit `eval/labels/` and `eval/photos/`.

Phase 2 (normalizers and validators, TDD from the signed labels) starts when `loadSignedLabels()` returns 120 labels. The kickoff is in `docs/prd-intake.md`, "Phase 2". Show the edge-case list before implementing.

Gate at the end of phase 1: typecheck, lint and `rules:lint` OK; `npm test` 571/571.

**The decisions-verify reseed hang is diagnosed (2026-10-14).** It was not a lock. A reseed makes ~1,480 commits, and with `synchronous_commit=on` each one waits on an fsync. During a laptop disk stall (Postgres log: a checkpoint syncing 44,846 files took 45s) each reseed went from ~1s to 17-20s. The first one past the 20s hook timeout kept running on the shared client while the next hook started, so the failures cascaded (`duplicate key`, `current transaction is aborted`). Fixes: `adjuster_test` now has `synchronous_commit=off` (applied, and set by `scripts/db-setup.ts`), and the reseed's TRUNCATE has a 5s `lock_timeout` that names the session holding the lock, so a real lock wait now fails fast with evidence. Not proven by a stalled run, since a disk stall can't be forced. If it recurs, check `grep "checkpoint complete" /opt/homebrew/var/log/postgresql@17.log` for that minute.

Phase 4 closure URLs are in `docs/RELEASE_NOTES.md`.
