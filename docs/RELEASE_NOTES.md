# Release notes: Phase 4 closure (2026-10-14)

Gate on closure: 51 test files pass, `decisions:verify` OK (67 decisions), `fixtures:check` OK, `rules:lint` OK.

## Closure deliverables

| Deliverable | Where |
|---|---|
| Demo script | `docs/DEMO.md` |
| Exec brief artifact | *pending: URL goes here* |
| LinkedIn drafts (Lab Intelligence Ledger, `https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i`) | *pending: draft titles go here* |
| Cost review | below |

## Cost review (2026-10-14)

Nothing is deployed: no Vercel project, no cloud Neon database, no LLM keys. Baseline spend from this project is zero except GitHub Actions minutes.

| Item | Decision | Restore note |
|---|---|---|
| Vercel cron `0 6 * * *` on `/api/cron` (`vercel.json`) | **Keep as is.** Daily, and inert while nothing is deployed. | If deployed, daily is already the floor; do not raise it. |
| Vercel auto-deploy per push | **Not applicable**; no project linked. `ignoreCommand` is in `vercel.json` for the day one is. | Verify both exit-code polarities before linking. |
| Neon / any cloud database | **None.** Local Postgres only; the cloud guard refuses a remote `DATABASE_URL`. | n/a |
| GitHub Actions CI (`.github/workflows/ci.yml`) | **Keep.** Runs on push to `main`, tags and PRs: `decisions:verify` must run on every push (non-negotiable 10). | If minutes ever matter, drop the PR trigger first, never the push to `main`. |
| LLM calls | **None.** Intake (AI track) is not started. | Decide cost when `docs/prd-intake.md` is opened. |
| Storage / blob | **None.** Evidence bytes are placeholder files under `uploads/` (gitignored). | n/a |
| Uptime pings, schedulers | **None.** | n/a |

## Open after closure

The carried lifecycle items and the list of what `decisions:verify` does not check are in `docs/phase-4-tasks.md` under "Carried in". Document Intake (`docs/prd-intake.md`) stays queued until Shane opens it.
