# Adjuster: demo script

> Learning project, synthetic data only. No real claimants, contracts or money; payments are mocked; no compliance claims.

Every command below was run once on 2026-10-14 against the local `adjuster` database. Expected output is quoted.

## Setup (once, about 2 minutes)

```bash
npm ci
npm run seed:demo          # two orgs, owner/admin/member each
npm run seed:decisions     # publishes every rule set, files and decides the golden claims
npm run dev                # http://localhost:4900/demo   (DEMO_MODE=1 in .env.local)
```

`seed:demo` prints `Seeded demo accounts. Sign in at /demo` and six accounts (`owner|admin|member@acme.demo.test`, same at `globex.demo.test`). `seed:decisions` prints `seed:decisions: 67 decisions`. It **replaces every rule set, contract, claim and decision** in the target database, so run it on the local one only (the cloud guard in `src/core/db` refuses anything else).

Credentials: owners and admins use TOTP. The secret is a fixed public demo value, `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`, printed by `seed:demo`. `member@` accounts need no code. `DEMO_MODE` lives in `.env.local`.

## Screens

| # | Where | Show | Say |
|---|---|---|---|
| 1 | Terminal: `npm run decisions:verify` | `decisions:verify: OK (67 decisions)` | Every stored decision is replayed from its own rule version and compared byte for byte. This gates CI on every push. |
| 2 | `/demo`, sign in as `owner@acme.demo.test` | The org home | One authorization path; roles and org scoping come from the foundation template. |
| 3 | `/o/acme/rules` | Versions grouped by product and kind, with status, hash, author, publisher | Rules are data, versioned and immutable once published. Two products (electronics, furniture) run on the same engine with no code difference (CP-01). |
| 4 | `/o/acme/rules/<id>` (click a version) | Edit a draft, diff it against the published version, publish | The author of a draft cannot publish it, enforced at the database. A draft with an unknown fact, a type mismatch or an overlapping row cannot be published. A claim decided afterwards selects the new version, no restart. |
| 5 | `/o/acme/claims/GC-01` | Claim status, decision, rules table, letter, payment | The letter renders from the **stored trace**, never from current rules. Claim status, decision outcome and payment status are three separate fields. |
| 6 | `/o/acme/claims/GC-05` | A referral, signed off | A rule gap or a flag is a referral, never an approval. Unknown is never false. |
| 7 | `/o/acme/claims/AP-01` | An appeal life (AP-01..06 are the six appeal fixtures) | No one decides an appeal of a claim they overrode. |
| 8 | `/o/acme/claims/GC-15` | The whole life on one page: events, documents, waivers, audit | Evidence, authority, override, mock payment and reopen are all replayable. |

Claim pages are not linked from the nav (there is no claims list); type the URL. Claim ids are the fixture ids: `GC-01..15`, `AP-01..06`, `FG-01..12`.

## Tamper demo (optional, 2 minutes)

`decisions:verify` names the failure code on any divergence. Cases it catches are in `tests/integration/` (ruleset hash, replay, sign-off authority). Do not edit rows by hand live: the immutability triggers will refuse it, which is the point to make instead.

## Other commands

```bash
npm run claims:no-response -- --as-of 2026-10-14   # the daily job, run by hand
```

Prints `claims:no-response: 0 reminded, 1 closed, 0 skipped on 2026-10-14` (it closed FG-10). **It changes the seeded data**; rerun `npm run seed:decisions` to reset. Without `--as-of` it prints usage.

```bash
npm test                  # 51 files, all pass
npm run fixtures:check    # frozen fixtures regenerate identically
npm run rules:lint        # schemas valid, no plan or product identifier under src/
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/o/acme/claims/GC-01` redirects (307) | Not signed in; go through `/demo` first |
| A claim page is 404 | Seed not run, or `seed:decisions` not run after `seed:demo` |
| Wall of ~1-second failures in a sweep | Environment: check `lsof -ti :4900` and `sysctl -n kern.memorystatus_level` before reading a stack trace |
| `too many clients already` | Another project's sweep holds connections; retry when it ends |
| `rules:export: 0 file(s) written` | Normal on a clean seed; it writes only versions authored in the browser |
| `seed:decisions` refuses to run | The database is not local (cloud guard); that is intended |

## What to concede before you're asked

- Synthetic data; mocked payments; nothing deployed. The daily cron is declared in `vercel.json` but there is no deployment to run it.
- No claims list page. Claim pages are reached by URL.
- A claim reopened by a rejected upload stays `REOPENED`; an approved-at-0 claim stays `DECIDED`; an appeal nobody can decide stays `UNDER_APPEAL`. Nothing times these out. The full list is in `docs/phase-4-tasks.md`, "Carried in".
- `decisions:verify` does not re-check some stored facts (a waiver's author tier, a payment above its decision). The services cannot write such rows; a forged row would pass.
- A staff-entered fact does not re-adjudicate on its own (D56 d).
- No compliance claims. Real claims handling is regulated and varies by state.
