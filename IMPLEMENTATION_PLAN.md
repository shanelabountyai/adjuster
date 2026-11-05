# SaaS Foundation: Implementation, Rollout and Sync Plan

Status: **APPROVED** · 2026-09-23 · implements `FOUNDATION_SPEC.md` (APPROVED v2).
Revised 2026-09-23 after a Codex review: all 9 findings are folded in (spec D-10–D-12, INV-28, spikes S1–S3, invariant staging, CI ownership, §3.2 route ownership).

This plan has three parts:
1. **Build:** milestones M0–M8, each one session-sized item with its own gate.
2. **Roll out:** which projects get the foundation, when, and which don't.
3. **Keep in sync:** how a fix made in the template reaches every clone, before and after the D-7 package extraction.

---

## 1. Build plan

**Working rules** (from `~/.claude/CLAUDE.md`):
- **One milestone per session.** At the end of each: commit and push, give an explicit clear verdict, and write the next milestone into `NEXT.md`.
- **Gate = lint + typecheck + vitest + the invariants listed for that milestone.** e2e runs only for the specs that milestone touches. CI owns the full sweep.
- **Model per milestone:** recommended below, and confirmed with the question tool at the start of each session.
- **Estimates are sessions, not days.** They are a guess until M0's spikes are done, UNVERIFIED.

| M | Milestone | Contents | Invariants turned green | Model | Est. |
|---|---|---|---|---|---|
| **M0** | **Repo, scaffold, spikes** | `git init`; private GitHub repo `saas-foundation`; secrets check before the first push. Next 16 app; `__PORT__` placeholder + `dev:template` on **4100**; port-table row in `~/.claude/CLAUDE.md` in the same commit. `.gitignore`, `swapcheck` pre-hooks, `vercel.json` with RB's `ignoreCommand`, ESLint core-boundary rule, CI skeleton (Postgres 17 service, lint + typecheck). **Spikes S1–S3** (below). | none | Sonnet | 1 |
| **M1** | **Core platform** | `env.ts` (zod), `clock.ts`, `db/` (PrismaPg + cloud guard in the app **and** `prisma.config.ts`), `log.ts`, global headers, `error.tsx` / `global-error.tsx`, `/api/health`, `.env.example`, `.env.test` with `connection_limit=10`. Vitest configured against local Postgres. **CI completed** (spec §9): vitest (unit + integration + invariants) and a prod-build Playwright job, green on this first commit with tests. | 14, 15 (public route), 18, 20 | Sonnet | 1 |
| **M2** | **Auth** | `tokens.ts`, Postgres `rate-limit.ts` (port from RB), email transport + `CapturedMessage`, magic link (port from GW), sessions, `/login`, `/login/[token]` (POST-to-spend), `/login/mfa`, TOTP + `secret-box` (port from RB, **with the step-returning change**), recovery codes, `/account/security`, sign-out-everywhere. **Sign-up by magic link** (D-10): `LoginToken.purpose`/`email`, and redeem upserts the user. | 05 (sign-out-everywhere), 07 (login token, session, recovery code), 09 (link requests, TOTP), 13, 15 (signed-in route), 17, 23, 24, 25, 26 (TOTP) | **Opus** | 2 |
| **M3** | **Tenancy + authz** | Org, Membership, Invite; `can()`, `requireUser`, `requireOrg`, `inOrg`; audit + append-only trigger migration; `/onboarding` (e2e: new email → org created); members page with **role-assignment rules** (D-11); **email change** (`requestEmailChange`/`confirmEmailChange` + account UI); org and account deletion. **The INV-01/02/03/04 harness from spike S2.** | 01, 02, 03, 04, 05 (membership removal), 06, 07 (invite), 09 (invite accepts), 19, 21, 22, 26 (deletion), **28** | **Opus** | 2 |
| **M4** | **Share links** | `ShareLink`, `toPublic*` contract with one example resource, `/s/[token]`, route headers, per-IP limit, create/revoke UI. | 07 (share link), 08, 09 (share reads), 15 (share route) | **Opus** | 0.5 |
| **M5** | **Cron + secret hygiene** | `cron.ts` (`isAuthorizedCron`, port from RB), `/api/cron` hourly, grep tests. | 10, 11, 16 | Sonnet | 0.5 |
| **M6** | **Billing module** | `billing.prisma`, `PaymentProvider` + mock, Stripe checkout and portal, webhook with raw-body verify + event claim + **re-apply when `processedAt IS NULL`**, `Idempotency-Key`, `/o/[org]/settings/billing`. | 12 | **Opus** | 1.5 |
| **M7** | **Notifications module** | `notifications.prisma`, outbox, drain in `/api/cron`, SMS via Twilio `fetch`, templates. | none new (13 re-checked) | Sonnet | 1 |
| **M8** | **Demo, clone tooling, release** | `seed-demo.ts` + `/demo`; `scripts/new-project.ts`; README; legal stubs; the **module-removal build check** in CI; `foundation:drift` / `foundation:status` scripts (§3); `CHANGELOG.md`, `CLONES.md`; **acceptance run** (spec §13: clean clone under 30 min, timed); tag **`v1.0.0`**. | 27 | Sonnet | 1 |

| **M9** | **Portfolio scorecard artifact** (requested 2026-09-23) | After `v1.0.0`: **re-score every code project** against the 14 key foundation pieces in `audit/CHECKLIST.md` (K1–K14). The pre-foundation baseline is `audit/<repo>.md` (2026-09-23) plus spec §3. Scores go in `audit/scorecard.json` (repo × K1–K14 → `✔` / `✗ text` / `N/A why`, with evidence file:line). Publish as an **Artifact**: one row per project, one column per key piece, a check mark when compliant, a short reason when not, linking to the backlog `SEC-nn` that fixes it. The foundation template is the first row and must be all `✔`. The artifact URL is recorded in `CLONES.md`. **Re-run it at each template release and after a batch of `SEC-nn` fixes lands**, republishing to the same URL. | none (reporting) | Sonnet (scoring: Opus for K3/K4) | 1 |

An invariant with a scope in brackets is partial there. **It is closed at the last milestone that lists it, and each milestone gates only its own scope.**

**Total: about 11 sessions to `v1.0.0`.** M4 and M5 can share a session.

### Spikes (M0): each answer is recorded in the spec's §0 before M1 starts

| # | Question | Pass condition | If it fails |
|---|---|---|---|
| S1 | Does a Prisma 7 multi-file schema work with module back-relations, and can a module be removed by deleting its file plus the listed back-relation lines? | `prisma validate` + `generate` **and `next build`** pass, both with the modules and after removing them per spec §4 (routes, cron hooks and module env vars included). `foundation:drift` passes on the module-removed tree (the `// <module>` markers). | Modules keep `orgId` as a plain column with no Prisma relation; the FK is written by hand in migration SQL |
| S2 | Can vitest import `'use server'` modules and call their exports, with `next/headers` (cookies) and `next/navigation` (`redirect`, `notFound`) mocked? | **Discovery:** the glob finds every export of a fixture set of at least 3 actions, with none registered by hand. **Arguments:** the harness builds valid input for any action without per-action code. The candidate is a core `orgAction(perm, zodSchema, fn)` wrapper that exposes its schema; the spike picks. **Controls:** four deliberately vulnerable actions (no guard; unscoped `where`; unscoped secondary id; data echoed before authz) turn INV-01/02/03/04 **red** with valid generated input, the correct versions stay green, and a row snapshot proves the database is unchanged. | Playwright harness posting to each action, **with the same discovery, argument and control requirements**. Slower, but real. |
| S3 | **Migration ordering across template and clone**: when the template ships a new core migration whose timestamp is earlier than a clone's latest own migration, do `prisma migrate deploy` and `migrate dev` apply it cleanly? | Deploy applies it; dev reports no drift; **`migrate reset` replays the merged history cleanly on an empty DB, including a later clone migration that depends on the new core table or column** | Any fallback (for example a sort-last prefix, §3.4) must pass the same clean-replay and dependent-migration checks before it is adopted. A sort-last prefix alone fails them. |

---

## 2. Rollout plan

| Project | What happens | When |
|---|---|---|
| **The next new project** | **First clone**, taken at `v1.0.0`, whatever that project is (spec D-9). Measured against spec §13: first domain feature within 1 day, zero auth/tenancy code. Gets the full Definition of Done (`DEMO.md`, exec brief, LinkedIn posts). | The first new project started after M8 |
| **Every new project after that** | Clone from the latest template tag. Claim the next free port hundred in the table at creation. | From v1.0.0 on |
| **Boxloop** | Not being built (spec D-9). Its PRD stays an input for conventions only. | n/a |
| **groundwork** | Stays independent; it is the source of the auth design. Its two MED fixes are backlog items in its own repo (D-5). | Any time |
| **rental, storage, Bookable, Countertop** | **Not adopting the foundation.** Their spec §3 gaps become backlog items in each repo (D-5). Priority: **storage webhook re-apply** and **Bookable IDORs** first, because those two are real bugs today. | Any time, in parallel with M0–M8, one repo per session |
| **Use-Case Studio** | Frozen (D-6). Three backlog items: hash + expire share tokens, fail-closed intake, move off :3000. | Low priority |
| **clinic, showcall, reservations, event toolkit, use-case-*, alongside** | Out of scope. No change. | n/a |

**Retrofitting an existing repo onto the foundation is not planned.** If a live repo ever needs orgs or MFA, the
foundation's modules are the reference to copy from, not a merge target, because those repos don't share its git history (§3.1).

---

## 3. Keeping clones in sync

### 3.1 Phase A (clones #1–#3): the template is a git upstream

**Clones share history with the template.** That shared history is what makes future fixes mergeable.

```bash
git clone git@github.com:shanelabountyai/saas-foundation.git my-app
cd my-app
git remote rename origin template          # the template stays reachable as "template"
git remote add origin git@github.com:shanelabountyai/my-app.git
git checkout -B main v1.0.0   # -B: a fresh clone already has a main
npm run new-project                        # name, port → rewrites package.json, README; removes dev:template
git push -u origin main
```

**Do not use GitHub's "Use this template" button.** It creates a repo with a single fresh commit and no shared
history, so every later fix becomes a hand-copy.

### 3.2 What belongs to whom

| Path | Owner | Rule in a clone |
|---|---|---|
| `src/core/**`, `prisma/schema/core.prisma`, core migrations, `tests/invariants/**`, `scripts/foundation-*.ts`, `FOUNDATION_VERSION` | **Template** | **Never edited in a clone.** Changes go upstream first (§3.3). |
| `src/modules/billing/**`, `src/modules/notifications/**` + their `.prisma` | **Template**, removable | Keep unmodified, or delete it entirely. A deleted module stays deleted when merging: resolve modify/delete conflicts by keeping the deletion. |
| **Security-relevant routes** (D-12): `src/app/(public)/login/**`, `src/app/(public)/demo/**`, `src/app/onboarding/**`, `src/app/account/**`, `src/app/o/[org]/settings/{members,security,billing,danger}/**`, `src/app/s/[token]/**`, `src/app/api/{health,cron,webhooks/stripe}/**`, `src/proxy.ts` | **Template** | Never edited in a clone. Each is a thin call into `src/core`. Clone cron jobs go in the clone-owned `src/app/cron-jobs.ts`, which `/api/cron` imports; clone org hooks (`beforeOrgDelete`, `filterListedOrgs`) go in the clone-owned `src/app/org-hooks.ts`, which the delete-org, `/onboarding` and `/demo` routes import. |
| The rest of `src/app/**`, `prisma/schema/<app>.prisma`, the app's own migrations, `tests/fixtures/app.ts` (harness rows for the app's `ref`s), `e2e/**`, `README.md`, `package.json` name/port | **Clone** | Free to edit. |

**Drift check (enforced):** `npm run foundation:drift` runs `git diff $(cat FOUNDATION_VERSION) -- <template-owned paths>`
and fails if anything differs. It ignores `core.prisma` lines marked `// <module>` when that module's directory is absent (spec §4). It runs in each clone's CI.

**Escape hatch:** a clone that must patch core urgently lists the path, a hash of the excused diff, and a reason in
`FOUNDATION_PATCHES.md` as `` `path` `hash` — reason `` (drift's failure message prints the `` `path` `hash` `` to paste in).
The hash is fingerprinted from the diff itself, so a further edit to that path changes the hash and drift fails again —
the excuse does not survive edits made after it was written. The patch is moved upstream at the next release.

### 3.3 Release and upgrade flow

**Versioning (semver on the template):**
- **patch:** bug or security fix, no schema change.
- **minor:** additive change (a new invariant, a new optional module, a new core table or column with a default).
- **major:** breaking change (a rename, a dropped column, an API change to `requireOrg`/`inOrg`, a data migration). A major release ships with an `UPGRADING.md` section.

**Releasing (in the template):**
1. Fix → gate green → a `CHANGELOG.md` entry. Entries prefixed `security:` are mandatory for anything touching an invariant.
2. Update `FOUNDATION_VERSION` to the new tag → commit → `git tag vX.Y.Z` → push with `--tags`.
3. Check `CLONES.md`, the registry of every clone, its repo and its current version.
   **For a `security:` release, every clone is upgraded within 7 days**, as a backlog item in each clone.

**Upgrading a clone:**
```bash
npm run foundation:status        # prints current version, latest tag, and any security: entries between them
git fetch template --tags
git merge vX.Y.Z                 # template-owned paths merge cleanly because the drift check kept them untouched
npm run db:migrate && npm test   # core migrations arrive with the merge
npm run foundation:drift         # confirms FOUNDATION_VERSION now equals vX.Y.Z and core matches
```
Then commit, push, and update that clone's row in the template's `CLONES.md`.

**Conflicts to expect:** `package.json` (dependency bumps against clone edits), and deleted modules (keep them deleted).
Security-relevant code, core and the routes in §3.2, is template-owned and kept identical by the drift check, so it merges cleanly.
A conflict inside a template-owned path means drift, and it is resolved by taking the template's side.

### 3.4 Migrations across template and clone

- Core tables are changed **only** by template migrations, and app tables only by the clone's. Neither ever alters the other's tables.
- The merge brings template migrations in as identical files, so Prisma's checksums match.
- **Ordering** is spike S3. Fallback if Prisma rejects out-of-order migrations: new template migrations get a name that
  sorts after any clone migration, generated by `scripts/foundation-migration.ts`, and a note in `UPGRADING.md`.

### 3.5 Phase B (after clone #3): extract a shared core package (D-7)

**Trigger:** the third clone is created, **or** an upgrade merge takes more than one session. Whichever comes first.

**Target shape:** `@shanelabountyai/foundation-core` on **GitHub Packages** (private npm), carrying:
- `src/core` compiled
- `core.prisma`, and core migrations
- a `foundation sync` CLI that copies `core.prisma` + migrations into the app. Prisma can't read a schema out of `node_modules`, which is the hardest part of the extraction.
- the invariant suite as an importable vitest config.

**Upgrading then becomes:** a version bump in `package.json`, then `foundation sync`, then `db:migrate`, then test.

**Costs to accept:**
- An `.npmrc` token in each clone and in Vercel.
- A publish step in the template's CI.
- Versioned releases that need more discipline than a merge.

The ESLint core-boundary rule from M0 is what keeps this extraction mechanical. **Phase B gets its own spec and plan when triggered.
Nothing in M0–M8 depends on it.**

---

## 4. Risks and mitigations

| Risk | Mitigation |
|---|---|
| New projects keep starting before `v1.0.0` exists, so the template never catches up | M0–M8 run back-to-back as the priority item. Any project started meanwhile uses its own stack and is not retrofitted. |
| The S2 harness fails, so INV-01 to INV-04 are hard to automate | Fallback is a Playwright harness (S2 row). These invariants stay mandatory and just run slower. |
| Clones quietly edit core, and merges start to hurt | `foundation:drift` in every clone's CI plus the `FOUNDATION_PATCHES.md` escape hatch. |
| A security fix doesn't reach a clone | `security:` changelog label + `CLONES.md` + the 7-day upgrade rule + `foundation:status` in each clone's `NEXT.md` routine. |
| Build minutes grow with every clone | Each clone gets `ignoreCommand` from the template. **The template itself is never deployed**: CI proves it, and clones deploy. |
| Scope creep inside milestones | Each milestone's invariant list is its done-line; anything else goes in the template's `BACKLOG.md`. |

---

## 5. Next actions

**Decided 2026-09-23 (Shane): the urgent live-security fixes run before M0.** A portfolio audit (`audit/`) found HIGH
issues on live sites: clinic has no gate; event toolkit lets an admin become owner; talk4me's paid TTS endpoint is open;
claude-dashboard binds all interfaces. The order is in `NEXT.md`. SEC items are appended to every audited repo's backlog.

1. **Approve this plan.** Answers to S1–S3 will be recorded in the spec's §0 as they come in.
2. **Start M0** in a fresh session (`NEXT.md` points to it).
3. **Separately, in parallel:** the D-5 items are **written** (2026-09-23) as a "Security findings" section with `SEC-nn`
   IDs in each repo's backlog, uncommitted, for each repo's own session to commit:
   - storage `docs/prds/06-backlog.md` (10)
   - Bookable `docs/prds/06-backlog.md` (7)
   - rental `docs/prds/06-backlog.md` (7)
   - Countertop `docs/backlog.md` (6)
   - groundwork `NEXT.md` (8)
   - `usecasestudiofiles/Use Case Studio — Backlog.md` (6)

   Start with storage SEC-01 (webhook re-apply) and Bookable SEC-01/02 (IDORs). One repo per session.
