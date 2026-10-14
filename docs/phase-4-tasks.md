# Phase 4 — Authoring UI, impact diff, second product

A claims manager edits a rule in a form, sees what the edit would do to the claims already decided, and a second person publishes it, with no deploy (Goal 4). Then a second product is added as rule data and fixtures with no change under `src/` (CP-01, Goal 5). This is the last phase, so it ends with the project's closure deliverables. No LLM, OCR, real payment or real data, ever.

What already exists and this phase builds on: `RuleSetVersion` has `draft | published | retired`, a draft's body is free to change and a published row is frozen by trigger (VP-01); `validateRuleSet` already reports every issue the PRD asks a draft to fail on (`UNKNOWN_FACT`, `TYPE_MISMATCH`, `OVERLAP`, `MISSING_TEMPLATE` and ten more); `publishRuleSet` refuses a backdated ops version (D44); the engine is pure, so running a draft over stored fact snapshots needs no new engine code; `renderDecision` gives a letter and a note from stored rows; `rules:lint` already walks every directory under `rules/` and reads plan identifiers from each dictionary; the template supplies sign-in, users, the audit log and Playwright.

What does not exist, read from the code on 2026-10-13:

- **Nothing writes a draft.** `publishRuleSet` inserts a file's body as `published` in one statement. No row has an author or a publisher.
- **The fact dictionary is a file read from disk at publish and at every decision** (`dictFile` in `src/adjudication/decisions.ts`: `rules/<product>/<factDictionary>.json`). It is not in the database, so "no deploy" can cover rule sets but not the dictionary.
- **The adjudication tables have no org column**, and the template's screens live under `/o/[org]`.
- **Who may do what is the template's three roles** (`src/core/authz/permissions.ts`, template-owned, not editable here) or the tiers in ops rule data (`TierAssignment`).
- **The seed names `rules/electronics` and four file names** (`scripts/seed-decisions.ts`), and `DocumentRejectionReason` is one list for every product (*Open after 3.3*).
- **No page shows a claim, a decision, a letter or a rule.**

## Decide first (each becomes a `decisions.md` entry in 4.1)

Items 1, 2, 4, 5 and 6 were put to Shane on 2026-10-13 and are D64 to D67; each kept its default except 5, which also takes the appeal flow. For the rest a default is given and none is taken until 4.1 records it. Item 3 changes what "no deploy" means, so it is Shane's to confirm.

1. **Which second product?** *(D64: furniture.)* O6's default is a furniture protection plan. Default: keep it. It has perils electronics does not (stains, rips, structural failure), no serial number, and a replace path that is a store credit, so it presses on the vocabulary in three places.
2. **What may CP-01 touch, and how is it proven?** *(D65: preparation, then two tags.)* Default: the product lands as one range of commits between two tags, `cp-01-base` and `cp-01-done`, and CI fails unless `git diff cp-01-base cp-01-done -- src/ prisma/` is empty. `rules/`, `fixtures/`, `tools/`, `scripts/` and `tests/` may change. Anything the product needs from `src/` or a migration (a vocabulary extension, a product column on the rejection reasons) lands **before** `cp-01-base`, each as its own recorded decision, and the write-up counts them. The alternative, a zero diff with no preparation allowed, means choosing a product weak enough to fit, which proves less.
3. **Where does a version published from the screen live?** `rules/` is the source the seed and CI load; a version made in the editor exists only in a database. Default: the database is the record (that is what "no deploy" means), and `npm run rules:export` writes any published version to `rules/<product>/` as canonical JSON so it can be committed; `rules:lint` fails if a published row's hash has no matching file only when asked (`--db`), never in CI. The alternative, the editor writing files and opening a commit, is a deploy by another name.
4. **Who may author and who may publish?** *(D66: powers in ops data.)* Publisher ≠ author is a CHECK on the row either way. For the right to do either, default: two powers in the ops rule set's `authority` (as `waive_documents` is), read through `TierAssignment` and `powersOf`, so no role name is tested in code. That is a vocabulary change and a new ops version. The alternative is the template's `admin` role for both, which is less code and puts a role name under `src/`.
5. **Which P1 items are in?** *(D67: the coverage report and the appeal flow.)* The rule coverage report (rows no stored decision ever hit), because the impact diff already walks every trace, and the appeal flow, which Shane added. Out: what-if replay beyond the diff, CSV, claimant status page, ex gratia, decision diff viewer.
6. **Is there a claim page?** *(D67: yes, read-only.)* The PRD's Phase 4 names authoring only, but nothing serves a letter (*Open after 3.11*) and the capstone is GC-15 narrated from stored rows. Default: one read-only page per claim (status, each decision with its letter and note, documents, payments, audit events). Nothing on it acts: accept, waive, override and pay stay services called by the seed.
7. **What does the editor edit?** Default: a rule row's cells (fact from the dictionary, operator from the closed set for that fact's type, a typed value), rows added and removed, lookup values, claimant and note templates, constants in payout steps, and the ops parameters (authority limits, reminder days, outcome policy). Not: the dictionary, adding or reordering payout steps, a rule's id or stage. Those stay a file edit and a decision entry.
8. **What does the impact diff run against?** The PRD says "all golden claims". Default: every claim's current engine decision in the database (the seed is the goldens played through the services), re-run through the pure engine at its stored `asOf` and stored snapshot, with the draft in place of the version of the same kind and product. For a plan draft that is hypothetical, since a stored contract keeps its pin (D3); the screen says so. Nothing is written but the summary on the publish audit event.
9. **Must the publisher have seen the diff?** Default: yes. `publishDraft` takes the content hash the diff was run on and refuses if the draft has changed since, and the audit event stores that hash and the diff's counts. Without it "show the deltas before publish" is a screen, not a rule.
10. **How many drafts at once, and when is the version number taken?** Default: one open draft per kind and product (a partial unique index), numbered at creation as the latest version plus one, copied from the latest published version. Two authors on one draft is last write wins, audited.
11. **Org scope.** Default: rule sets, contracts and claims stay global (one synthetic administrator); the pages sit under `/o/[org]` only for the session and the audit actor. Said in the scope-honesty section of the write-up, not built around.
12. **The seeded count.** The PRD's metric says about 60 seeded claims; there are 19 (32 decisions). Default: add the second product's goldens (about ten) and concede the number. Claims are frozen fixtures from the oracle, and padding with generated ones tests nothing new.
13. **The appeal's rules.** What exists: PL-01 has `DECIDED → UNDER_APPEAL → DECIDED`, guarded by a denial; the brief gives the senior adjuster the power to decide appeals and says no one decides an appeal of their own decision; D33 makes an appeal a superseding decision that names the documents it relied on. Defaults: only a denial may be appealed, once; the appeal is filed with a reason and may bring documents and facts; deciding it runs the engine on the facts as they then stand and writes a superseding engine decision, and a person holding the power, who made no earlier decision or override on the claim, either lets that stand or overrides it under D59; an engine denial has no author, so "own decision" binds overrides and waivers only; an upheld denial closes the claim, and `reopenClaim` then refuses a denied claim. Whether an appeal may be decided for another amount than the engine's is D59 (b) again, and stays no.

## Tasks

Services first, then the product, then the screens: the product is where the vocabulary is under pressure, and the screens are built once, knowing two products exist.

- [x] **4.1 Decisions and fixtures.** (D68 to D75; `ops-v3`; AU-01..05, ID-01..04, OV-04; 74 fixtures. ID-01 also moves GC-13, which the Phase 1 hand check missed.) Record the twelve items above. The oracle then produces `AU-01..` (one draft per validation code the PRD names, each expected to fail with exactly that code, plus the draft lifecycle as a transition table like PL-01: who may save, who may publish, author publishing refused) and `ID-01..` (named edits with their expected deltas: Essential deductible 5000 to 30000 moves GC-01 to APPROVE at 0 and nothing else, as checked by hand at the Phase 1 gate; `plan-v2` against `plan-v1`; one ops edit that moves a referral; one edit that moves nothing). `verify_fixtures.py` gains typed keys for both kinds and planted mutations fail it.
- [x] **4.2 Draft rows.** (D76; `src/adjudication/drafts.ts`; migration `20261013000000_draft_rows`. AU-05 plays `create` and `save` through the services; its allowed `publish` steps are applied by hand in the test until 4.3.) Migration: `authoredBy`, `publishedBy`, `basedOnId` on `RuleSetVersion`, a CHECK that they differ when both are set, the index of item 10. `createDraft` (copy of the latest published), `saveDraft` (body only, draft only, re-validated, issues returned and not thrown, because a form mid-edit is invalid), each audited. Seeded rows keep null authors.
- [x] **4.3 Publish a draft.** (D77; `publishDraft` and `exportRules` in `src/adjudication/drafts.ts`. A same-day ops version is refused, `OPS_SAME_DAY`; a retired ops version stays selectable and nothing retires one.) `publishDraft(db, {id, userId, diffHash})`: validation clean, dictionary hash matches, publisher is not the author and holds the power, `OPS_BACKDATED` still refused, content hash and `publishedAt` set in the same statement. `publishRuleSet` stays as the seed's loader of files. Settle here the two questions a person can now reach from a screen: a same-day ops version, and whether a new decision may select a retired ops version (D37, D44). No retire button until the second is answered.
- [x] **4.4 Impact diff.** (D78; `impactDiff` and `unhitRows` in `src/rules/impact.ts`, `impactOfDraft` in `src/adjudication/drafts.ts`. `before` is the stored trace's; coverage is rule rows only, lookup rows are not in a trace; the publish event carries the counts.) A pure function in `src/rules`: the draft, the versions it would replace, and a list of `{snapshot, asOf, contract pin, stored trace}` in; per claim, outcome, reasons and payable cents before and after, out. A service reads the cases from stored rows and writes nothing. ID fixtures pass; the same call reports the rows no stored decision ever hit (the coverage report).
- [x] **4.5 Appeal.** Item 13, on electronics, before the second product so its rules are settled once. Fixtures first: an appeal upheld (GC-04 or GC-14, still denied, closed), an appeal that brings a document and is approved, an appeal decided by the person who overrode refused, a second appeal refused, an approved claim's appeal refused. Then `fileAppeal` and `decideAppeal` in the pipeline, the power read from the ops version in force, the letters' "what to do next" line, a verify check and its tamper case if 4.1 names one. Money and authority: an Opus item.
- [x] **4.6 Second product: brief first.** (D80 to D84; `docs/domain-brief.md` section 12, PRD addendum A; H1..H23, HF1..HF8, FP-A..I, FG-01..12. Every vocabulary question took its first option, so 4.7 adds no vocabulary.) A PRD addendum and a section of `docs/domain-brief.md` for the product: plans, perils, exclusions, documents, payout order, about ten goldens with cents worked by hand. Then a list of everything the closed vocabulary cannot express, each one a decision for Shane before any data is written. Shane reads the brief before 4.7.
- [x] **4.7 Preparation, then `cp-01-base`.** (D85; migration `20261013020000_rejection_reason_product`; one change under `src/`, the review's insert reading the product from the claim's plan. No vocabulary extension. Tagged.) Everything item 2 allows before the tag and nothing else: the product column on `DocumentRejectionReason`, any vocabulary extension 4.6 decided (each with its fixture), the seed and the oracle reading every directory under `rules/` instead of one name. Electronics' fixtures do not move. Tag.
- [x] **4.8 CP-01.** (D86, D87; `rules/furniture/`; FP-A..I, FG-01..12, RE-24, RE-25; 104 fixtures, 67 seeded decisions. One thing did not fit, the spelling of a rule id: the brief's H and HF ids became E101.. and F101.., and `src/` was not touched. Tagged; CI checks the two tags.) `rules/<product>/` (dictionary, one plan version, one ops version), its fixtures from the oracle, its goldens in the seed. `git diff cp-01-base -- src/ prisma/` is empty; tag `cp-01-done`; a CI step checks the two tags for ever. `decisions:verify` is OK across both products. If a rule will not fit, stop and go back to 4.6; do not reach for `src/`.
- [x] **4.9 Rule-set pages.** (`/o/[org]/rules` and `/o/[org]/rules/[id]`, a "Rule sets" link in the org nav; `tests/integration/rule-pages.test.ts`. A null author or publisher reads "file", the seed's loader; a draft whose body does not parse is shown as its JSON; `money` exported from `src/rules/render.ts` rather than written twice.) Versions by product and kind, with status, effective date, hash, author and publisher; one version read as tables. Server components, no rule logic in the client. Spec-following: a Sonnet item.
- [x] **4.10 The editor.** The form of item 7 over a draft: selects built from the dictionary and the closed operator set, native inputs typed by the fact, issues shown beside the cell they name. Saving calls `saveDraft`; the page never validates by itself.
- [x] **4.11 Diff and publish screens.** The deltas of 4.4 as a table (claim, before, after, reasons added and removed, cents), the coverage list, and a publish button the author cannot use. One Playwright spec: one user changes the deductible and sees GC-01 move, a second publishes, the version list shows both names. Runs against the production build.
- [x] **4.12 Claim page.** (`/o/[org]/claims/[id]`, `tests/integration/claim-page.test.ts`; letters and notes render from each decision's stored trace; reached by URL only, no list page or nav link.) The read-only page of item 6: GC-15 read top to bottom on it, and an appealed claim.
- [ ] **4.13 Seed and gate.** Both products and the appeals seeded through the services; `decisions:verify:test` OK in CI; TM-01..09 and the Phase 3 tamper cases still each fail with exactly their code; `rules:lint` finds no identifier of either product under `src/`.
- [ ] **4.14 Closure.** The global definition of done: `docs/DEMO.md` with every command run once, the exec brief, the LinkedIn drafts in the Ledger, the cost review (the cron at `0 6 * * *`, CI minutes; nothing is deployed), every artifact URL in `docs/RELEASE_NOTES.md`.

**Exit criteria:** AU, ID and the appeal fixtures pass. No one decides an appeal of a claim they overrode. A draft with an unknown fact, a type mismatch, an overlapping `unique` row or a missing template cannot be published. The author of a draft cannot publish it, at the database. A rule is edited, diffed and published from the browser with no file change and no restart, and a claim decided afterwards selects it. CP-01: the diff of `src/` and `prisma/` between the two tags is empty and CI checks it. `decisions:verify` is OK across two products, their plan versions and ops versions. GC-15 can be read from one page. The four closure deliverables exist and are linked from the repo.

## Carried in, not owned by a task

Each is open in `decisions.md` under the heading named. Defaults are in force; none blocks a task above unless it says so.

**Phase 4 makes these reachable or visible, so they want an answer before the gate:**

- A referral letter prints a visible rule's claimant text under the neutral sentence (GC-10, against D42). On a page, someone will read it. (*3.11*)
- A pend letter cannot say a sent document was rejected; the reasons have no claimant wording, and the wording belongs in rule data. (*3.11*)
- The rejection reasons are one list for every product. Owned by 4.7. (*3.3*) *Done, D85.*
- ~~A same-day ops version; whether a new decision may select a retired ops version.~~ Settled in 4.3 (D77 a, b).
- A reseed leaves the earlier seed's audit events, so a claim page in a database seeded twice shows two lives under one claim id. (*3.12*)

**Shane's, on the claim lifecycle:**

- A staff-entered fact does not re-adjudicate (D56 d). (*3.5*)
- A later staff entry silently outranks a fact read from an accepted document. (*3.4*)
- A claim reopened by an upload that is then rejected, or for a supplemental that brings no new fact, stays `REOPENED`; closing it needs a new move in PL-01. (*3.6*, *3.9*)
- A claim approved at 0, or a supplemental not above what was paid, stays `DECIDED`; nothing closes it by itself. (*3.9*)
- ~~`reopenClaim` reopens a denied closed claim.~~ Settled in 4.5 for a denial upheld on appeal (D79 f). A denial nobody appealed can still be closed and reopened for a supplemental. (*3.9*)
- An appeal that can never be decided stays `UNDER_APPEAL`; nothing times it out (D79, open). (*4.5*)
- `history.priorClaims` is filed by hand, not read from `Payment` rows (D60 f). A second claim on one contract would need a new derived input and a fixture. (*3.9*)
- A claim can be closed for no response with no reminder sent, if the job first runs on or after `closeDay`. (*3.6*)

**What `decisions:verify` does not check** (a forged row passes each; the services cannot write one):

- That an appeal's decider held the tier written on the row on that day. (*4.5*)
- That an override's author, or a waiver's, held the tier written on the row on that day. (*3.7*, *3.8*)
- A stored waiver at all. (*3.3*)
- Two overrides of one decision. (*3.8*)
- That the document version ids in a decision exist and were accepted. (*3.4*)
- `Payment`: a row above its decision's amount, a claim paid above its total. (*3.9*)
- That `FLAG_CLEARED` overrides a flagged referral; the reason code is a label. (*3.8*)

**Enforced by the services, not the database:**

- A raw `UPDATE` of `Claim.status` (D38).
- The primitives `reviewDocument`, `waiveDocument` and `uploadDocument` are exported, so "accepting re-adjudicates" and "an upload reopens" hold for callers of the pipeline only. (*3.5*, *3.6*)
- Nothing limits who may call `assignTier` (D58 g). (*3.7*)
- A fact can be entered from the wrong document (D55 c). (*3.4*)

**Not built, and staying seams:**

- A reminder is delivered to no one and nothing schedules the no-response job. (*3.6*)
- The payment provider is called inside the transaction: right for a mock, wrong for a real one. (*3.9*)
- Ex gratia and an override that denies (D59 b). (*3.8*)
- A corrupt stored file fails every read and every new upload of the same bytes; nothing repairs it, on purpose. (*3.2*)
- `tools/recompute_from_trace.py` refuses a `min_of` step; no rule data uses one (D43). A second product that needs one changes that.
- ~~P1 to P6 in `decisions.md` are still marked proposed.~~ Confirmed in 4.6 (D84).

**Test environment:**

- The template's `resetDb` empties the reference tables (`DocumentRejectionReason`, `OverrideReason`); a test that needs them puts them back. (*3.4*, *3.8*)
- `decisions-verify.test.ts` reseeds before each of its 15 tests and passes the hook limit when other projects' sweeps hold the machine. (*3.12*)
