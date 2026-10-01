## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. Real claims handling is regulated (state unfair claims settlement practices acts, prompt-payment statutes, service contract acts, Magnuson-Moss, adjuster licensing, privacy law — all varying by state); this project models the *decisioning mechanics*, makes no compliance claims, and must never touch real claimants, real contracts or real money. Payments are mocked.

# adjuster — Insurance Claims

Rules-as-data claims adjudication. Spec: `prd-adjuster-insurance-claims.md`; working rules: `CLAUDE.md`; current work: `docs/phase-1-tasks.md`.

> Cloned from saas-foundation v1.2.0. Port 4900. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

A Next.js 16 + Prisma 7 + Postgres template with the parts every multi-tenant app rebuilds: magic-link sign-in with TOTP,
orgs and roles, one authorization path, an append-only audit log, share links, cron, and optional billing (Stripe) and
notifications (SMS). Its safety rules are executable: `tests/invariants/` holds INV-01 to INV-28, and CI fails if one breaks.

Design and decisions: `FOUNDATION_SPEC.md`. Milestones and the sync model: `IMPLEMENTATION_PLAN.md`. Releases: `CHANGELOG.md`. Clones: `CLONES.md`.

## Quickstart (about 10 minutes)

Needs Node 22 and a local Postgres 17 you can create databases in (Homebrew `postgresql@17` works with no password).

```bash
git clone git@github.com:shanelabountyai/saas-foundation.git my-app
cd my-app
git remote rename origin template
git checkout -B main v1.0.0   # -B: a fresh clone already has a main
npm ci
npm run new-project -- my-app 4200   # name and port; rewrites package.json, CI, Playwright, README
npm run db:setup                     # creates my_app and my_app_test, writes .env.local and .env.test, migrates both
npm run seed:demo                    # two orgs, owner/admin/member each; owners and admins have TOTP
npm run dev                          # http://localhost:4200/demo
```

**Do not use GitHub's "Use this template" button.** It drops the shared history, so later fixes can't be merged.
Working on the template itself: `npm run dev:template` serves on :4100.

`db:setup` never overwrites an existing `.env.*` and never prints a value. It uses your OS user against `localhost:5432`;
set `PGUSER`/`PGPASSWORD` or `LOCAL_PG_URL_BASE` for a different Postgres. Real keys (Resend, Stripe, Twilio) are optional
and go in `.env.local`; without them email is captured in the database, billing uses a mock, and SMS is off.

## Commands

| Command | What it does |
|---|---|
| `npm test` | vitest against the local test database: unit, integration and all invariants |
| `npm run test:e2e` | Playwright against a production build (`E2E_DEV=1` runs the dev server for debugging one spec) |
| `npm run lint` / `typecheck` | ESLint (including the core-boundary rule) and `tsc` |
| `npm run db:migrate` | create a migration in dev; `db:migrate:test` applies to the test database |
| `npm run seed:demo` | idempotent demo accounts; refuses a cloud database |
| `npm run foundation:drift` | in a clone: fails if a template-owned file was edited |
| `npm run foundation:status` | in a clone: current vs latest release, and any `security:` changelog entries between |
| `npm run foundation:check-modules` | builds a scratch copy with both modules deleted (CI runs it) |

## Layout

- `src/core/`: env, db, auth, tenancy, authz, audit, tokens, email, share links, cron. Never imports from `src/modules` or `src/app` (lint-enforced).
- `src/modules/{billing,notifications}/`: optional, deletable.
- `src/app/`: routes. `src/app/cron-jobs.ts` is where a clone adds its own cron work.
- `prisma/schema/`: `core.prisma` plus one file per module. A clone's tables get their own file and migrations.
- `tests/invariants/`: the security rules as tests. `tests/fixtures/app.ts` holds a clone's harness rows.

## Removing a module

Delete the paths listed for it in `scripts/foundation-modules.ts`, and the lines marked `// billing` or `// notifications`
(`{/* billing */}` in `layout.tsx`) in `prisma/schema/core.prisma`, `src/app/cron-jobs.ts` and `src/app/o/[org]/layout.tsx` —
that includes the module's nav link, so it goes with the rest.
`foundation:check-modules` does exactly this in a scratch copy and requires validate, typecheck, build and drift to pass.
The module's tables stay in the migration history; drop them with a clone migration if you want them gone.

If your own code imports a module outside the marked lines (a clone's own routes or lib files, not just
`cron-jobs.ts`/`org-hooks.ts`), list it in `src/app/required-modules.ts`. `check-modules` leaves a required module in
place and still removes the rest.

## Staying current

Template-owned paths (core, modules, invariants, security routes) are never edited in a clone, so `git merge vX.Y.Z` is clean.
An urgent local patch goes in `FOUNDATION_PATCHES.md` as `` `path` `hash` — reason `` (drift prints the hash to paste in) and moves upstream at the next release. The excuse stops matching, and drift fails again, once that path changes further.
Upgrade steps and versioning rules: `IMPLEMENTATION_PLAN.md` §3.3.

## Not included

Legal pages are stubs (`/legal/privacy`, `/legal/terms`) and are not legal advice. There is no audit-log viewer and no
`/o/[org]/settings/security` page yet.

No cookie banner: the foundation sets only strictly necessary cookies (`session`, `totp_pending`), and those need no consent.
If you add analytics, ads or any other non-essential tracker, you need consent first (spec D-20).
