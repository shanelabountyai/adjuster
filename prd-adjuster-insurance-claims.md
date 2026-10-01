# PRD: Adjuster — Insurance Claims

**Sample business:** "Adjuster," claims adjudication for a small service-contract administrator (consumer electronics and appliance protection; three plan tiers: Essential, Plus, Premier)
**Status:** Draft v1.0 — product-owner + senior-claims-adjuster review baked in
**Learning objectives:** rules-as-data decision engine, immutable versioned rule sets, an adjudication pipeline where every decision carries an explanation, replayable decisions, evidence-document handling

---

## ⚠️ Scope Honesty (read first)

Learning project, synthetic data only. Real claims handling is regulated (state unfair claims settlement practices acts, prompt-payment statutes, service contract acts, Magnuson-Moss, adjuster licensing, privacy law — all varying by state); this project models the *decisioning mechanics*, makes no compliance claims, and must never touch real claimants, real contracts or real money. Payments are mocked. Banner verbatim in the README.

## Problem Statement

Claim outcomes depend on coverage terms that change more often than software ships: waiting periods, exclusions, deductibles, limits. When those terms live in `if` statements, every change needs a developer, nobody can say which terms decided an old claim, and "why was I denied?" is answered by reading code. Adjuster stores eligibility and payout logic as versioned data, runs every claim through an explicit pipeline, and refuses to store a decision without a structured explanation. The builder lesson: a rules engine is a discipline about where logic may live and how a decision proves itself later; the evaluator is the easy part.

## Goals

1. Every eligibility and payout rule is data in a published, immutable rule-set version; no plan-specific branch exists in code.
2. Every decision replays byte-identically, forever, from its pinned rule versions and frozen facts.
3. Every decision carries a structured explanation that renders both a claimant letter and an internal file note, cites every reason that applies, and suffices to recompute the payout by hand.
4. A non-developer (claims manager) can edit a rule, see its impact on existing claims, and publish — with no deploy.
5. **(Builder goal)** Hold the data/code boundary under pressure: when a rule is hard to express, extend the closed vocabulary by recorded decision; never add an escape hatch.

## Non-Goals

- LLM adjudication, OCR, document extraction (facts are human-entered and attributed; seam: `FactSource` interface)
- Real payments (mock `PaymentInstruction` only; no ledger — LoanBook covers that)
- Fraud scoring / ML (red flags are plain refer-rules; seam: a score would be one more fact)
- Policy admin, sales, pricing, cancellations/refunds (contracts are seeded, read-only)
- Theft/loss cover, liability, subrogation, reserving, reinsurance, servicer dispatch, state form variations (single line, single currency; rule sets are keyed by product so a second line is data)

## Requirements — Must-Have (P0)

**P0-1: Rules engine core** *(core learning artifact #1)*
A pure function `evaluate(planVersion, opsVersion, facts, asOf) → result + trace`. Eligibility is decision tables whose cells are `{fact, op, value}` from a closed operator set; payout is an ordered list of closed calc steps. Rule catalog E1–E23, red flags F1–F10 and payout order are in `docs/domain-brief.md`.
- [ ] Operators are exactly `eq, neq, lt, lte, gt, gte, in, not_in, between, is_known`; calc steps are exactly `start_from, subtract, apply_bps, cap_at, floor_at, min_of`. Anything else fails schema validation (RE-01..RE-18)
- [ ] Rules read only facts declared in a typed fact dictionary; derived facts come from a closed set (`days_between`, `full_years_between`, `ratio_bps`, `count_claims_in_window`, `sum_prior_paid`). An unknown fact fails publish
- [ ] Three-valued logic: a condition over a missing fact is UNKNOWN and yields `PEND` listing what is missing; it never evaluates as false (RE-19..RE-22)
- [ ] Eligibility evaluates **all** rules and collects every reason (no first-match); no matching row yields `REFER / RULE_GAP`; no input can produce a default approval (RE-23)
- [ ] Integer cents and bps only; rounding mode (half-up) is a rule-set field, applied in one module
- [ ] The engine module imports no clock, database, or plan identifier (lint + CI grep)

**P0-2: Rule-set versioning and pinning**
Two rule sets per product, each versioned as a whole, `draft → published → retired`, immutable and content-hashed once published. **Plan versions** (perils, exclusions, waiting period, deductible, limits, valuation) are pinned by the contract at purchase — coverage cannot change after the sale. **Ops versions** (authority limits, red flags, evidence checklist, reminder timing) are selected by adjudication date.
- [ ] UPDATE/DELETE of a published version is rejected by a DB trigger (VP-01); version selection is itself a traced step (VP-02..VP-04)
- [ ] Each decision stores both version ids and hashes, the canonical fact snapshot, `inputHash`, `outputHash`, `engineSemanticsVersion`
- [ ] RV-01: publishing plan v2 changes the outcome for a contract sold after it and leaves every existing contract's decisions unchanged and still verifying

**P0-3: `decisions:verify`**
The invariant that gates every phase: replay every stored decision from what it pinned and prove byte-identical output.
- [ ] Exits non-zero with a coded failure for each of `RULESET_HASH_MISMATCH`, `FACTS_HASH_MISMATCH`, `REPLAY_DIVERGED`, `EXPLANATION_INCONSISTENT`, `VERSION_NOT_EFFECTIVE`, `CHAIN_BROKEN`, `OVERRIDE_INVALID`, `SEMANTICS_UNSUPPORTED`
- [ ] Tamper fixtures TM-01..TM-08 (loaded below the service, raw SQL) each trigger exactly their one code; runs in CI on every push and takes `--as-of`

**P0-4: Adjudication pipeline and claim state machine**
Fixed stage order (code): intake → contract verification → coverage period → peril/exclusions → frequency/limits → evidence sufficiency → red flags → valuation → deductible/limits → authority → decision → payment (mock). Stage *logic* is data.
- [ ] Only "contract not found" short-circuits. Stages 3–5 always all run. Valuation never runs on a denied claim: amount is **null**, not 0. A covered loss under the deductible is **approved at 0**
- [ ] Outcome precedence: objective deny > pend for evidence > refer > approve/partial. Judgment exclusions (pre-existing, abuse) and red flags refer, never auto-deny; flags never appear in claimant text
- [ ] Claim status, decision outcome and payment status are three separate fields; legal transitions are a table and an illegal one throws (PL-01)
- [ ] Decisions are append-only. Re-adjudication with an unchanged `inputHash` is a no-op; with changed facts it inserts a superseding decision under the same plan version (PL-02, PL-03)
- [ ] Golden claims GC-01..GC-14 (the seed scenarios) produce the expected outcome, reasons and cents

**P0-5: Explanation model** *(core learning artifact #2)*
The explanation is structured trace data stored at decision time: each rule evaluated, facts read, result, reason code, contract clause, and each calc step with input, operand and output cents. Templates live on the rule row.
- [ ] `explanation` is NOT NULL with a CHECK for a non-empty trace, written in the same transaction as the decision; an insert without one fails at the DB (PL-04)
- [ ] Claimant letter and internal note render from the same stored trace by placeholder substitution only; never regenerated from current rules (PL-05)
- [ ] A denial lists every reason that fired, each with its clause (GC-04, GC-14)
- [ ] Hand-recompute test: a script given only the explanation JSON reproduces `payableCents` for every golden

**P0-6: Evidence documents** *(core learning artifact #3)*
The ops rule set declares which documents each claim type requires. Documents are immutable, content-hashed records; facts drawn from them are entered by a human and attributed.
- [ ] Missing required documents yield `PEND` naming each one (EV-01, EV-02); a claim already objectively deniable is not asked for documents
- [ ] Status `REQUESTED → RECEIVED → ACCEPTED | REJECTED(reason)`, plus `SUPERSEDED`, `WAIVED(reason, by)`. Uploads are never overwritten; a replacement supersedes (EV-03). Files via a `DocumentStore` interface (local disk, SHA-256)
- [ ] Every evidence fact records `documentVersionId`, `enteredBy`, `enteredAt`; each decision records the exact document versions relied on (EV-04)
- [ ] Accepting evidence triggers re-adjudication (EV-05). No response: reminders, then `CLOSED_NO_RESPONSE` on the injected clock — not a denial, and reopenable (GC-11)

**P0-7: Human authority, override and rule authoring**
Authority tiers (system / adjuster / senior / manager) are ops rule data, tested on **total incurred on the claim**, not the increment. Rule editing is a form-based table editor for drafts.
- [ ] An override is a separate decision row with reason code + text, linked to the preserved engine decision; out-of-authority overrides are rejected (OV-01..OV-03)
- [ ] A supplemental claim reopens the same claim, recomputes the total, pays the difference, and never takes the deductible twice (GC-15)
- [ ] A draft fails validation on unknown facts, type mismatches, overlapping rows in `unique` tables, or missing templates
- [ ] Impact diff: run the draft against all golden claims and show outcome and payout deltas before publish; publisher ≠ author, both audited
- [ ] CP-01: a second product with its own plans is added as rule data and fixtures with **zero changes under `src/`**, proven by a CI diff check

## Nice-to-Have (P1)

Appeal flow (decider ≠ original decider) · rule coverage report (rows never hit) · what-if replay of old claims under a new version · table CSV import/export · claimant status page · ex-gratia payments · decision diff viewer.

## Success Metrics (seeded)

- `decisions:verify` reports OK across ~60 seeded claims, two plan versions, two ops versions and two products
- GC-01..GC-15 and payout fixtures PAY-A..PAY-H: 100% to the cent, with two independent oracle scripts agreeing
- CP-01 passes with a zero-line diff under `src/`
- Capstone (GC-15): one Premier laptop claim's full life — FNOL, evidence pend, evidence received, waiver override, adjudication, referral, payment, supplemental converting repair to replace — narrated entirely from stored decisions and explanations

## Phasing

1. Engine core + `decisions:verify` (nothing else until the invariant holds) — 2. Versioning, pipeline, explanations — 3. Evidence, re-adjudication, authority/override, mock payment — 4. Authoring UI, impact diff, second product (CP-01) + P1.

## Build Notes for Claude Code

CLAUDE.md: house conventions + **no plan-specific logic in code**, **no eval or expression strings**, **published rule sets and decisions are immutable**, **no decision without an explanation**, **unknown is never false and a rule gap is never an approval**, **run `decisions:verify` in CI on every push**. TDD order: fact dictionary and schemas → fixtures → condition evaluator → table evaluator → calc steps → verify → pipeline. Do this *by hand first*: before any evaluator code, adjudicate three golden claims on paper from the rule tables alone and write the explanation you would want to receive. That page is the trace schema.
