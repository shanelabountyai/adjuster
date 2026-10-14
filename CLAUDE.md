# CLAUDE.md — Adjuster

Learning project: rules engine as versioned data, explained adjudication pipeline, replayable decisions, evidence documents. **Synthetic data only. Never real claimants, contracts or money. No compliance claims.** Keep the scope-honesty banner verbatim in README.md.

Read first: `prd-adjuster-insurance-claims.md` (what), `docs/decisions.md` (rules the PRD left open — authoritative), `docs/domain-brief.md` (plan terms, rule catalog E1–E23, flags F1–F10, payout order, golden claims), `fixtures/README.md` (frozen expected values). Current work: `docs/phase-2-tasks.md`.

## Non-negotiables
1. **No plan, product or coverage-specific logic in code.** No plan names, tier checks, or dollar thresholds under `src/`. If a rule can't be expressed, stop and propose a vocabulary change in `docs/decisions.md`.
2. **No `eval`, `Function`, expression strings or dynamic imports** anywhere in the rule path. The operator and calc-step sets are closed (D1).
3. **Published rule-set versions and decision rows are immutable**, enforced at the DB layer. A change is a new version; a correction is a superseding decision.
4. **No decision without an explanation** — NOT NULL + CHECK, written in the same transaction. Letters render from the stored trace, never from current rules.
5. **The engine is pure.** No clock, database, network or randomness. Time arrives as `asOf`.
6. **Unknown is never false; a rule gap is never an approval.** Missing fact → `PEND`. No matching row → `REFER / RULE_GAP`.
7. **Collect every reason.** No first-match; only "contract not found" short-circuits.
8. **Denied → amount null. Under deductible → approved at 0.** Claim status, decision outcome and payment status are separate fields.
9. **Integer cents and basis points only.** One rounding rule (half up, read from the rule set), one module. Everything hashed goes through the single canonical-JSON serializer.
10. **`decisions:verify` gates everything** and runs in CI on every push.

## Working rules
- **TDD order:** fact dictionary + schemas → fixtures → condition evaluator → table evaluator → calc steps → persistence → verify. Write the failing test against a fixture first.
- **Fixtures are frozen.** Tests read `fixtures/`; code never generates them. Never edit a fixture to make a test pass — change `docs/decisions.md` first, regenerate with `tools/build_fixtures.py`, confirm `tools/verify_fixtures.py` prints OK, review the diff.
- `tools/build_fixtures.py` is a test oracle, not product code. Don't import or port it.
- Phase gate: don't start the next phase until the current phase's exit criteria pass. Phases: 1 engine+verify → 2 versioning+pipeline+explanations → 3 evidence+authority+override+mock payment → 4 authoring UI+impact diff+second product.
- Adding an operator, calc step or derived fact needs a `docs/decisions.md` entry and a fixture.
- Rule data lives in `rules/` as JSON and is loaded into the DB; it is not TypeScript.
- Small commits; one concern each. Note seams for non-goals but don't build them.
- Ask before adding dependencies.
- **Model is pinned to Opus 5.5** in `.claude/settings.json` (open item O5). Drop to Sonnet only for an item with no new logic.

## Stack
TypeScript on a clone of saas-foundation v1.2.0: Next.js 16, Prisma 7, PostgreSQL 17, vitest, Playwright. Port 4900. `Int` cents named `...Cents`, basis points named `...Bps`. Immutability via triggers as hand-written SQL in Prisma migrations. Python only in `tools/`. Template-owned paths (`src/core/**`, `tests/invariants/**`, core migrations) are never edited here.

## Commands (create in Phase 1, task 1)
- `npm test` — vitest against the local `adjuster_test` database
- `npm run decisions:verify` — replays every stored decision; exits non-zero with a failure code on any divergence
- `npm run fixtures:check` — `python3 tools/build_fixtures.py && python3 tools/verify_fixtures.py && git diff --exit-code fixtures/`
- `npm run rules:lint` — schema-validates `rules/` and greps `src/` for plan identifiers

## Definition of done (any task)
Tests green, `decisions:verify` clean, no plan-specific logic or float in `src/`, decisions doc updated if a rule changed.

## Queued after Phase 4: Document Intake
`docs/prd-intake.md` (AI track: PDFs and photos in, typed facts out, confidence per field, review queue, eval scorecard). Not started and not part of Phase 4. Do not build any of it until Shane opens it. Its first session is the read-only contract check described at the end of that file. Where that PRD and `docs/decisions.md` disagree, `docs/decisions.md` wins.
