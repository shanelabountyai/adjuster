# Phase 1 review — what contradicts itself, and what could not be built as written

Written 2026-10-01 at the end of setup tasks 1.1, 1.3, 1.4, 1.5, from reading the PRD, `CLAUDE.md`, `docs/decisions.md`, `docs/domain-brief.md` and `docs/phase-1-tasks.md`. **Nothing here is resolved.** Where the rule data or a fixture had to take a side to exist, that is stated, and each is a small change to reverse. Numbers quoted were run through the interpreter in `tools/verify_fixtures.py`, not worked out by eye.

## A. The documents disagree

1. **Which decisions file is current.** The kickoff message says D1–D30 are resolved. `docs/decisions.md` (and `STARTER.md`) stop at D22 with O1–O7 open, and the domain brief's PAY-E note says the depreciation outcome is "accepted in decisions D26", while O4 says it is still open. D23–D30 are missing, or the brief points at a decision that was never written. *Fixtures assume the file as it stands, with the O1–O7 defaults.*
2. **Files named as existing that do not.** `CLAUDE.md` lists `fixtures/README.md` ("frozen expected values") as read-first and `tools/build_fixtures.py` as the oracle; neither was in the kickoff folder. Both were written in task 1.5.
3. **D19 against the brief on E8, E12, suspected E10.** D19: judgment exclusions "never appear in claimant text". Brief s3 gives claimant reason text for E8 ("The condition existed before coverage began."), E10 and E12, and s2 says they "refer with a recommendation". The PRD only bars *flags* from claimant text. *Encoded: the text is kept, with `claimantVisible: false` (D19's side). One bit to flip.*
4. **F5 against GC-13 (PAY-G).** F5 refers when the estimate is ≥95% of the per-claim limit. PAY-G's estimate is 62000 against a 50000 limit, so F5 fires and the claim is `REFER`; GC-13 expects "Partial 50000", no referral. The payable is 50000 either way (checked). The outcome is not. Not in GC-01..10, so no frozen fixture depends on it yet.
5. **Ops rules that need plan terms.** D2/D3 version the plan and ops sets separately and select ops by `as_of`, but F1 (waiting period ends), F5 (per-claim limit, replace threshold) and E23 (payable) read plan terms. The PRD's list of what ops contains ("authority, red flags, evidence checklist, reminder timing") also omits E5, E17, E21, E22, which the brief marks Class O. *Encoded via P2 and P5 in `decisions.md`.*
6. **Stage 2 against E22.** Stage 2 says holder and product mismatch → *refer*; E22 (claimant is holder or transferee) → *pend*. *Encoded: E22 pends, in the evidence stage.*
7. **GC-14 or GC-15.** PRD P0-4 says GC-01..GC-14 are "the seed scenarios"; everywhere else the set is GC-01..GC-15, where 15 is the capstone narrative, not a single decision.
8. **GC-05's reasons.** The table says "Replace threshold; E23". Replace-versus-repair is a valuation path, not a rule that fires; only E23 does. *Fixture reasons: `["E23"]`, the path is in the calc trace.*
9. **Task order.** Task 1.3 writes a trace schema and 1.5 freezes traces, but the PRD says the by-hand page (task 1.2) *is* the trace schema, and 1.2 comes after. The schema is `adjuster.trace/0`, provisional; if your page differs, regenerate. Fixtures freeze only outcome, reasons, per-rule result, calc steps and cents, which the page is unlikely to change.
10. **Task 1.5 against "do not write evaluator code".** The oracle has to adjudicate, and `verify_fixtures.py` interprets the rule JSON. Both are Python in `tools/`, which `CLAUDE.md` allows as a test oracle. Nothing evaluator-shaped exists under `src/` except the publish-time validator (declarations only, never fact values).
11. **D16 (one half-up rule) against D17 (repair vs replace as a table over `ratio_bps`).** "C > 70% of R" is not what a half-up `ratio_bps` compares: C = 77001, R = 110000 is 7000.09 bps, rounds to 7000, reads as *repair* and pays 69501 less the deductible, though C exceeds 77000 and the brief says replace. Any threshold test through a rounded ratio misfires within half a basis point of the line. Needs a per-function rounding mode or a cross-multiplied comparison.

## B. Could not be built as written

12. **No fact-to-fact comparison.** Cells are `{fact, op, literal}`. E5 (serial matches), E22 (holder), E16 (prior paid < aggregate limit) and E3 (days vs the plan's waiting period) compare two facts. *Encoded: E5 and E22 are human-entered booleans; E3 and E16 carry per-tier literals that duplicate `lookup.*` values (verified equal by `verify_fixtures.py`, not by any mechanism).*
13. **The calc steps cannot express the payout order.** Repair-vs-replace is a branch, ACV retention is a table lookup, aggregate remaining is a subtotal, "partial" and "contract fulfilled" need intermediate amounts. *Encoded: P3 (registers, `when` guards, `lookup.*` facts). `min_of` is undefined in every document; `cap_at` already is "min of the running amount and an operand", so `min_of` here means the minimum of a list, ignoring the register, and the plan does not use it.*
14. **Date arithmetic.** F1 ("within 7 days after the waiting period ends") needs a date plus a plan term; the derived set has none. *Encoded: the contract carries `waitingEndsOn` (seeded: start + waiting period); E3 does not use it.*
15. **History facts.** `count_claims_in_window` and `sum_prior_paid` need the contract's earlier claims in the frozen snapshot (a `list` fact, P4). Unstated: whether denied or withdrawn claims count toward E15 and F2; what "rolling 12 months" is (365 days used); whether "same serial" is "same contract" (used). F6 spans contracts and F7/F10 need document metadata, so none can be derived: input facts. *Encoded: E15 counts APPROVE and PARTIAL, E17 and F2 count any outcome.*
16. **Numbers the brief never gives.** E13's N months (modelled as a human-entered boolean), F4's "more than N days … soon after" (30 and 60 as placeholders), F5's "just under the replace threshold" (6500–7000 bps placeholder). Rule `note` fields say PROVISIONAL. No GC-01..10 fixture turns on them.
17. **Premier battery claims.** The deductible table lists "2500 breakdown / 9900 ADH", no battery figure, so a Premier battery claim has no deductible row and hits `RULE_GAP` at valuation. E6 (battery is a covered peril) and E9 (battery is a consumable unless below 80%) also both speak to it.
18. **Undefined terms.** "Partial" (used: payable below the amount after deductible, so per-claim or aggregate caps; the price cap alone is APPROVE, as in PAY-F). "Contract fulfilled" (used: a replacement on a plan that fulfills on replacement, or aggregate remaining after the payment is 0). PAY-F gives "total loss" but no repair figure (C set equal to R).
19. **Skipped stages and PEND.** The brief skips valuation and documents on a denial; this skips stages 6–10 (documents, flags, valuation, authority) on `DENY`, and gives a PEND a null amount. E1 is modelled as stored contract status; if it also tested the dates it would fire with E2 and GC-04 would cite three reasons, not two.
20. **RE-01..RE-23 are never defined.** The PRD names the range and the tasks assign RE-01..12 to the condition evaluator, 13..18 to calc steps, 19..22 to three-valued logic, 23 to rule gap. Proposed: 01–10 one operator each; 11 unknown operator or step; 12 unknown fact or type mismatch; 13–18 one calc step each; 19 missing fact is UNKNOWN per operator; 20 Kleene AND; 21 `neq`/`not_in` over a missing fact are UNKNOWN; 22 PEND names the missing facts and a TRUE row outranks UNKNOWN; 23 rule gap. Note 22 is a rule-level case that task 1.7 assigns to the condition evaluator.
21. **The fact dictionary sits outside the hashed rule sets.** D2/D4 make a published rule set immutable and content-hashed; the dictionary both sets read is a separate file. Changing it would change what an old decision means without changing a hash. It needs to be hashed into each set or versioned itself.
22. **Smaller:** clause numbers: only §2.1, §3.1, §4.3, §5.2 and §6.1 appear in the brief, the rest in `rules/` are invented. E17's "{id}" has no source in the closed vocabulary (`history.duplicateClaimId`, an input). `auto_deny_enabled = false` is undefined (must a denial become a referral?). "Waiting period N per plan/peril" but the table has one value per plan.

## C. Where open items O1–O7 touch a fixture

| Item | Fixtures that move if the default flips |
|---|---|
| O1 auto-deny | GC-02, GC-03, GC-04, GC-09 and PAY-H: DENY would become a referral with the amount still null |
| O2 deductible after the per-claim limit | PAY-G (50000 → 45000) and the future GC-13; nothing in GC-01..10 reaches the per-claim limit |
| O3 drop the ACV schedule | PAY-E and GC-08 (46500 → 72500; price cap 80000 − 7500) |
| O4 lesser/greater step on ACV replace | PAY-E and GC-08 (the 46500-against-70000 case) |
| O5 model pin | none |
| O6 second product | none until CP-01 |
| O7 E4 contractual or operational | none (no GC-01..10 reports late); it moves the rule between files |

## D. Verified, not assumed

All of PAY-A..PAY-G, GC-01..GC-10 outcomes and reasons, and the cents match the brief's tables to the cent, from two independent routes (`build_fixtures.py` procedural, `verify_fixtures.py` interpreting `rules/`). The verifier was made to fail on purpose three ways (a deductible changed in the rule data, a fixture payable off by 100, a wrong RE-22 expectation) and caught each.
