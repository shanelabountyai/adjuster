# Phase 1 — Engine core + `decisions:verify`

Nothing else until the invariant holds. No UI, pipeline stages, documents or overrides in this phase.

- [x] **1.1 Scaffold.** Commands in CLAUDE.md exist (verify may be a placeholder that exits 1). Scope banner verbatim in README. Clone row in `saas-foundation/CLONES.md`. `.claude/settings.json` model pin.
- [ ] **1.2 By hand first (Shane).** Adjudicate GC-01, GC-04 and GC-08 on paper from `docs/domain-brief.md` alone and write the explanation you would want. Check in as `docs/trace-by-hand.md` — the trace schema reference.
- [x] **1.3 Schemas.** JSON schemas for fact dictionary, decision tables, calc steps, rule-set envelope, trace. Tests reject an unknown operator, an unknown fact, a type mismatch.
- [x] **1.4 Rule data.** `rules/electronics/plan-v1.json` and `ops-v1.json` encoding E1–E23, F1–F10, the three tiers and payout order D15. Passes `rules:lint`.
- [x] **1.5 Fixtures.** `tools/build_fixtures.py` + `tools/verify_fixtures.py` (second derivation) produce RE-01..RE-23, PAY-A..PAY-H and GC-01..GC-10 (engine-level: facts in → outcome, reasons, cents, trace out). Both agree; fixtures frozen; CI fails if product code writes to `fixtures/`.
- [x] **1.6 Canonical JSON + hashing.** Shuffled key order → identical bytes and hash. Floats rejected.
- [x] **1.7 Condition evaluator.** Three-valued logic. RE-01..RE-12, RE-19..RE-22 pass.
- [x] **1.8 Table evaluator.** `collect` and `unique` hit policies, rule gap, outcome precedence D8. RE-23 passes; a `unique` overlap fails validation.
- [x] **1.9 Calc-step evaluator.** Cents, bps, half-up. RE-13..RE-18 and PAY-A..PAY-H pass; no float in the module.
- [x] **1.10 Persistence.** `RuleSetVersion` and `Decision` tables; immutability triggers; explanation NOT NULL + CHECK. VP-01 and PL-04 pass at the DB layer.
- [x] **1.11 `decisions:verify`.** All eight codes. TM-01..TM-08 loaded below the service each fail with exactly their code; clean seed (GC-01..GC-10 decided) reports OK.
- [x] **1.12 CI gate.** Pipeline fails if `decisions:verify`, `fixtures:check` or `rules:lint` fails. Prove it on a throwaway branch with one tampered decision.

**Exit criteria:** RE, PAY and GC-01..GC-10 fixtures pass; `decisions:verify` OK on the clean seed and failing correctly on TM-01..TM-08; CI enforces it; `grep` finds no plan name, tier or threshold under `src/`.

**Before Phase 2:** change one deductible in a copy of `plan-v1.json`, re-run the goldens, and confirm the outcome changes with no code change.
