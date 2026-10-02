# Adjuster — Resolved Decisions & Open Items

The PRD leaves several rules open. The frozen fixtures in `fixtures/` encode the answers below.
If you change a decision, change the fixtures deliberately, not the tests. This file outranks PRD text.

## Resolved (encoded in fixtures)

| # | Decision | Why |
|---|----------|-----|
| D1 | Rules are **decision tables** with `{fact, op, value}` cells plus an ordered list of closed **calc steps**. No JSONLogic, CEL, DSL, `eval` or expression strings. Operators: `eq neq lt lte gt gte in not_in between is_known`. Calc steps: `start_from subtract apply_bps cap_at floor_at min_of`. | A claims manager can read a table; a closed vocabulary cannot grow into a language or run code. PRD P0-1 |
| D2 | Two rule sets per product, each versioned **as a whole**: **plan version** (contractual) and **ops version** (operational). `draft → published → retired`; published is immutable and content-hashed. | Rules interact, so one version id must mean one complete behavior. Domain brief §8 |
| D3 | **Plan version is pinned on the contract at purchase.** **Ops version is selected by adjudication `as_of`.** Date of loss decides whether cover was in force, never which terms apply. | Coverage cannot change after the sale; authority and fraud rules are the insurer's current practice. Adjuster's convention, overriding the PO default (date of loss) |
| D4 | A decision pins both version ids and hashes, the canonical fact snapshot, `inputHash`, `outputHash`, `engineSemanticsVersion`, and the document version ids relied on. | Replay needs nothing outside the decision row and the rule sets |
| D5 | Everything hashed goes through one canonical-JSON serializer: sorted keys, integers only, ISO dates, no floats. | "Byte-identical" means nothing without it |
| D6 | `decisions:verify` with eight failure codes gates every phase and runs in CI. | The executable invariant, as `ledger:verify` is for LoanBook. PRD P0-3 |
| D7 | Hit policies: `collect` for eligibility (all rules run, all reasons kept), `unique` for lookups (overlap fails at publish). No priority or first-match. | Priority ordering hides conflicts; adjusters cite every denial ground |
| D8 | Outcome precedence: **objective deny > pend for evidence > refer > approve/partial**. A claim already objectively deniable is not asked for documents. | Adjuster's convention, overriding the PO default (refer before pend) |
| D9 | Kleene three-valued logic. A condition over a missing fact is UNKNOWN → `PEND`; never false. | A missing receipt is a request for evidence, not a denial |
| D10 | No matching row → `REFER / RULE_GAP`. Nothing can default to approve. | Silent approval is the costliest failure in a decision system |
| D11 | The explanation is stored trace data. Templates live on the rule row and allow placeholder substitution only. Letters and notes render from the stored trace, never from current rules. | One source for letter and audit view; wording changes without a deploy |
| D12 | Stage order is code; stage logic is data. Only "contract not found" short-circuits. | The skeleton is stable; making it configurable teaches nothing here |
| D13 | Decisions are append-only. Re-adjudication is a no-op on an unchanged `inputHash`; otherwise it inserts a superseding decision under the same plan version and the ops version current at `as_of`. Never automatic on a rule publish. | New evidence changes facts, not the terms in force |
| D14 | Denied claim → `payableCents` is **null**. Covered loss under the deductible → **approved at 0**. | Different outcomes with different claimant rights |
| D15 | Payout order: covered repair cost → replacement value → basis (RC or ACV) → repair/replace at 70% of R → cap at purchase price → deductible (floor 0) → per-claim limit → aggregate remaining. Only paid amounts erode the aggregate. The order itself is plan-rule data. | Domain brief §4; fixtures PAY-A..PAY-H |
| D16 | Integer cents (`...Cents`), basis points (`...Bps`), round half-up, mode stored on the rule set, applied in one module. | House convention |
| D17 | Derived facts come from a closed set declared in the fact dictionary: `days_between`, `full_years_between`, `ratio_bps`, `count_claims_in_window`, `sum_prior_paid`. Repair-vs-replace is a `unique` table over `ratio_bps(C, R)`. | Stops date and money math leaking into code helpers |
| D18 | Override is a separate decision row with reason code + text, linked to the preserved engine decision. Authority tiers are ops-rule data, tested on total incurred on the claim. | Engine result stays intact; supplements can't be split under a limit |
| D19 | Red flags and judgment exclusions (E8, E12, suspected E10) refer; they never deny and never appear in claimant text. | Domain brief §9 |
| D20 | Documents: local disk behind `DocumentStore`, SHA-256, immutable, superseding versions. Evidence facts are human-entered with `documentVersionId`, `enteredBy`, `enteredAt`. No OCR or LLM. | Keeps the engine deterministic; `FactSource` is the seam |
| D21 | Publish requires an approver who is not the author; both audited. | The foundation already has roles and an audit log |
| D22 | Stack: clone of saas-foundation v1.2.0, port 4900. Template-owned paths are never edited. Python only in `tools/` (the oracle). | Same as loanbook D10 |

## Open — need Shane's call (defaults are in force until changed)

| # | Question | Default in the fixtures | Why it's open |
|---|----------|------------------------|---------------|
| O1 | Auto-deny on objective rules, or a human on every denial? | `auto_deny_enabled = true` (ops parameter) | Adjuster: many shops require a human on every denial, but it is not universal |
| O2 | Deductible before or after the per-claim limit? | Before | Usual convention unless the contract says otherwise; not universal |
| O3 | Keep the ACV depreciation schedule (20%/yr, max 60%)? | Keep | It is a property-insurance concept; real service contracts more often use like-kind replacement or a buyout capped at price. Kept as a teaching parameter |
| O4 | ACV replace can pay less than the repair estimate (PAY-E: 46500 vs 70000). Accept, or add "pay the lesser/greater of" step? | Accept as written | Follows from D15; flagging so it is a choice, not an accident |
| O5 | Model pin for this repo | Opus 5.5, as loanbook | Rules + money logic; unanswered from the last session |
| O6 | Second product for CP-01 | Furniture protection plan | Any product with different perils proves the point |
| O7 | Is E4 (late reporting) contractual or operational? | Contractual | It is a contract condition, but some shops treat the window as practice |

## Not modeled (seams only)
Theft/loss cover · appeals beyond P1 · ex gratia · cancellations/refunds · real payment rails · OCR/LLM extraction · fraud scoring · state-specific denial-notice content and timelines.

## Reuse check — 2026-10-01 (Session 0, run against `docs/phase-1-tasks.md`)

`python3 ~/Projects/reuse-scan.py check docs/phase-1-tasks.md adjuster` parsed only 1 of 12 tasks (its parser skips `- [ ] **N.N Title.**` lines) against one indexed project: reuse 0 · adapt 0 · new 1. That is not a real answer, and `find` timed out grepping every project, so it was supplemented by reading loanbook directly.

| Task | Verdict | From | Note |
|---|---|---|---|
| 1.1 commands | 🟡 ADAPT | loanbook `package.json` | `fixtures:check` is the same line; `decisions:verify` mirrors `ledger:verify` (`scripts/ledger-verify.ts`) |
| 1.5 fixtures | 🟡 ADAPT | loanbook `tools/build_fixtures.py` + `verify_fixtures.py` | Same two-oracle pattern (Fraction vs Decimal), same README conventions. Fork, not copy: Adjuster's second derivation interprets `rules/*.json`, loanbook's re-derives numbers |
| 1.3 schemas | 🟢 REUSE | template's `zod` | No new dependency; JSON Schema is emitted with `z.toJSONSchema` (`npm run rules:schemas`) |
| 1.10 immutability | 🟢 REUSE | template migration `20260923100000_audit_append_only` | Same hand-written-SQL-in-a-migration style, when 1.10 arrives |
| 1.2, 1.4, 1.6–1.9, 1.11 | 🔵 NEW | — | The real size of the project: the rule vocabulary, canonical JSON, the evaluators, replay |

Where they diverge, this file and the PRD govern, not loanbook.

## Proposed — vocabulary the rule data needed (awaiting Shane; `rules/` already uses them, so rejecting one means editing rule data and fixtures)

D1 and D17 close the vocabulary. Writing E1–E23 and the payout order as data needed these additions. None is decided; each is a one-line change to undo. Detail in `docs/phase-1-review.md`.

| # | Proposal | Needed because |
|---|----------|----------------|
| P1 | Rows must be exhaustive: an explicit `PASS` row per rule, so "no row matched" can mean `RULE_GAP` | Otherwise a table of deny-rows approves by default, against D10 |
| P2 | Plan lookups (`lookup.*`, `unique` tables) are facts, readable by the ops rule set | F5 needs the per-claim limit; D2/D3 version plan and ops separately |
| P3 | Calc steps: named registers, `when` guards (the repair/replace branch), operands `{fact\|const\|reg}`; `min_of` takes a list of operands and ignores the register | The brief's payout has a branch and an aggregate-remaining subtotal; D1 lists step names only |
| P4 | One more fact type, `list` (prior claims), feeding the closed derived set | `count_claims_in_window` and `sum_prior_paid` need history in the frozen snapshot |
| P5 | Contract carries `waitingEndsOn`; E5 and E22 are human-entered booleans | No fact-to-fact comparison and no date arithmetic in the vocabulary |
| P6 | Rule-set rows carry `claimantVisible`; flags may never carry claimant text (validator enforces) | D19 and the brief disagree about E8/E12 (review item 3) |

## Phase-1 review answers — 2026-10-02 (Shane; recommended option taken each time)

| # | Decision | Review item | Fixture / data effect |
|---|----------|-------------|-----------------------|
| D23 | This file (D1–D22) is the authority. The brief's "D26" for the ACV outcome means open item O4, accepted as written. | 1 | none |
| D24 | D19 wins: E8, E10, E12 reason text stays stored with `claimantVisible: false`; claimant letters show neutral wording only. | 3 | none (current encoding) |
| D25 | F5 fires only below the limit: estimate ≥ 95% **and < 100%** of the per-claim limit. At or over the limit it is a plain cap → PARTIAL (GC-13 / PAY-G stands). | 4 | applied: F5.hit0 is 9500–9999 bps; rows F5.clear2/3 pass at ≥10000 |
| D26 | Repair-vs-replace compares by integer cross-multiplication (cost × 10000 vs threshold bps × R), no rounded ratio. Implemented as derived fn `ratio_exceeds_bps` (bool: `num*10000 > bps*den`), fact `d.repairExceedsReplaceBps`; the `path` table tests it. Fixture PAY-I (77001 of 110000 → replace, payable 100000). | 11 | applied: new derived fn, PAY-I; F5's rounded ratio bands stay (provisional) |
| D27 | O1 auto-deny on, O2 deductible before limit, O3 keep ACV schedule, O4 accept lesser payout, O7 E4 contractual — all defaults confirmed. | O1–O4, O7 | none |
| D28 | The fact dictionary's hash is recorded in each rule-set envelope and checked at publish. | 21 | envelope schema + hash (task 1.6) |
| D29 | Deferred or accepted as encoded: fact-to-fact operator (12, a seam); Premier battery stays `RULE_GAP` (17); history counting as encoded (15). | 12, 15, 17 | none |

Still unanswered: P1–P6 above, and review items 5–10, 13, 14, 16, 18–20, 22 (all encoded provisionally; none moves a GC-01..10 fixture).
