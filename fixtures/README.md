# Fixtures

Frozen expected values. Tests **read** these; product code must never generate them.

| Dir | Covers | Kind |
|-----|--------|------|
| `re/` | RE-01..RE-23, evaluator level: one per operator (01-10), validation failures (11-12), one per calc step (13-18), three-valued logic (19-22), rule gap (23) | `condition`, `condition-list`, `row`, `rule`, `calc`, `validate` |
| `pay/` | PAY-A..PAY-G and PAY-I (the D26 boundary): facts in, calc-step trace and payable out. PAY-H is a pointer to GC-02 (a denial carries a null amount) | `valuation`, `ref` |
| `gc/` | GC-01..GC-10 and GC-12..GC-14: a full fact snapshot in, outcome, reasons, every rule's result, calc trace and cents out. `plan` is the contract's pin; `ops` is the version in force on `asOf` (D35, so GC-04 names `ops-v2`). GC-05 also carries `signoff`: the adjuster's override of its referral. GC-11 (no response) and GC-15 (the capstone, `step` = the brief's step number) are claim lives | `decision`, `lifecycle` |
| `rv/` | RV-01: GC-01's loss under a contract sold before `plan-v2` and one sold after; each case is a `decision` fixture | `rule-version` |
| `vp/` | VP-02..VP-04: version list + contract pin + `asOf` → `{plan, ops}`, or `{error: NO_EFFECTIVE_VERSION, kind}`. Dates of loss and report are there to be ignored | `selection` |
| `pl/` | PL-01: the claim status table (statuses, legal moves, and which decision each guarded move out of `DECIDED` needs; D38). PL-06: a claim whose contract is not on file → no rule runs, no decision, claim `REFERRED` (D35). PL-02 and PL-03: one claim run more than once (D40). Each run has its `asOf`, the `change` entered on the claim before it, and what comes back: `expected.decision` is the run whose decision row is returned (an earlier run = a no-op), `expected.supersedes` the run that row supersedes. PL-04 and PL-05 are behaviours with no data of their own | `transitions`, `pipeline`, `readjudication` |
| `ev/` | EV-01..EV-05, claim lives about documents: pend naming each one, no documents asked on a denial, an upload supersedes, the versions a decision relied on, acceptance re-adjudicates (D51, D52) | `lifecycle` |
| `ov/` | OV-01..OV-03: tier, power, cents paid on the claim and amount being approved → `{totalIncurredCents, allowed, lacks}` under the named ops version (D50, D51) | `authority` |

**Reading a `lifecycle` fixture.** `events` are in order. Each has an `asOf`, one `action` (`open`, `upload`, `accept`, `reject`, `waive`, `tick`, `override`, `pay`, `reopen`) and the state it must leave in `expected`. `open` carries the facts known at FNOL; `accept` carries the facts entered from that version. `expected.decision` is the claim's current decision: `row` is its position among the claim's decision rows, `supersedes` and `overrides` point at rows the same way, and `documentVersions` are ids of the form `<type>/<n>` (map them to real ids in a test). `notPassed` lists every rule that did not pass, with the unknown facts it is waiting on. `tick` is the no-response job run on that date.

Conventions: amounts are integer cents, rates are basis points, dates are ISO `YYYY-MM-DD`. Facts use the ids in `rules/electronics/facts-v1.json` (flat, dotted). A decision fixture's `expected.rules` lists every rule that ran; compare by `ruleId`, not position. `expected.skippedStages` is non-empty exactly when an objective denial stopped evidence, flags, valuation and authority from running.

**What is and is not in `expected`.** Outcome, reasons (rule ids), per-rule result, calc steps (input, operand, output cents) and payable are frozen. Prose (claimant letter, file note, the step `labels` beside the calc steps; D42), `rowIds`, `factsRead`, `vars` and `versions` are not: they are the engine's own output, checked against the trace schema (`adjuster.trace/1`, D34) rather than a golden file.

**RE-xx are a proposal.** The PRD and tasks name RE-01..RE-23 but nowhere define them; the mapping above is mine. Review it before task 1.7.

**Where the numbers come from.** PAY-A..PAY-H and the GC outcomes are the answer key in `docs/domain-brief.md` s4 and s11. Facts the brief does not state (dates, replacement values, which documents are in) are filled in so every other rule passes; each GC title says what the scenario is about.

## Provenance and how they were checked

- `tools/build_fixtures.py` adjudicates the brief's claims procedurally with exact rational arithmetic (`fractions.Fraction`). It does not read `rules/`.
- `tools/verify_fixtures.py` derives them a **different way**: it interprets `rules/electronics/*.json` with `decimal` arithmetic and Kleene three-valued logic, and checks the result against answer keys typed in from the brief. It must print `OK`. That one run proves the fixtures *and* that the rule data encodes the brief.
- Claim lives are simulated twice. The builder walks each claim with its own procedural adjudicator and typed authority table; the verifier replays the events from their actions alone, with the rule-data interpreter, the tiers and reminder days in the ops file and PL-01's moves, and compares every event.
- Run: `npm run fixtures:check` (builds, verifies, then `git diff --exit-code fixtures/`, so it fails if anything rewrote a fixture and it was not committed on purpose).

## Rules
- Never edit a fixture to make a failing test pass. If a fixture is wrong, change `docs/decisions.md` first, regenerate with `tools/build_fixtures.py`, confirm `tools/verify_fixtures.py` prints OK, review the diff.
- `tools/` is a test oracle, not product code: do not import it, do not port it.
