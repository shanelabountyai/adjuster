# Trace by hand (task 1.2)

Adjudicated on paper from `docs/domain-brief.md` alone, before looking at the
fixtures or `src/`. This page is the reference for the trace schema
(`src/rules/schema.ts`, `adjuster.trace/0`); where they differ, the schema
changes and the fixtures are regenerated.

**How to fill this in.** The brief's §11 already gives each claim's outcome,
so getting the right answer is not the test. The test is **what you'd write
down to justify it**. Replace every `___` with your answer. Rough notes are fine.
If the brief doesn't tell you something, write **brief doesn't say**. That
counts as a finding.

Where to look: rules are in §3 (E1–E23), the payout steps in §4, letters in §5
(it has sample letters), plan terms in the §1 table, and red flags in §9.

---

## GC-01 — Essential, washer → Approve 25000

Given: motor fails in month 8; repair estimate 30000; documents complete.

**Facts I relied on** (list each one with a value, and make up any dates you need):
- Contract start date: ___
- Date of loss: ___
- Date reported: ___
- Peril: ___
- Purchase price / replacement value R: ___ (the brief doesn't give these, so how did you handle that?)
- Other: ___

**Rules checked.** For each stage in §2, write pass/fail and the reason. Would you
list *every* rule E1–E23, or only the ones that applied? ___

| Stage | Rules (E#) | Result | Why |
|---|---|---|---|
| 3 Coverage period | ___ | ___ | ___ |
| 4 Peril & exclusions | ___ | ___ | ___ |
| 5 Frequency & limits | ___ | ___ | ___ |
| 6 Evidence | ___ | ___ | ___ |
| 7 Red flags | ___ | ___ | ___ |
| 10 Authority | ___ | ___ | ___ |

**Payout math.** Work through §4 steps 1–8 and write the number at each step:
1. C = ___
2. R = ___
3. V = ___
4. Repair or replace? ___ (show the comparison)
5. Price cap → ___
6. Deductible → ___
7. Per-claim limit → ___
8. Aggregate → payable ___

**Outcome:** ___

**Claimant letter** (2–3 sentences, in the style of the §5 "Approve" example):
> ___

**Internal file note** (1–2 lines for another adjuster):
> ___

---

## GC-04 — Plus → Deny (two reasons)

Given: loss 10 days after the term ended; scratches only.

**Facts I relied on:**
- Contract start / end: ___
- Date of loss: ___
- Damage description: ___
- Other: ___

**Rules checked:**

| Stage | Rules (E#) | Result | Why |
|---|---|---|---|
| 3 Coverage period | ___ | ___ | ___ |
| 4 Peril & exclusions | ___ | ___ | ___ |
| 5 Frequency & limits | ___ | ___ | ___ |
| 6 Evidence | ___ | ___ | ___ |
| 7 Red flags | ___ | ___ | ___ |

Did you keep checking after the first failed rule? Why or why not? ___

**Payout math:** ___ (on a denial, what's the amount: 0, blank or "none"?)

**Outcome:** ___

**Claimant letter** (follow the §5 "Deny" example and cite every reason):
> ___

**Internal file note:**
> ___

---

## GC-08 — Plus → Approve 46500

Given: price 80000, R 90000, product age 2 years, C 70000.

**Facts I relied on:**
- Contract start date / date of loss: ___
- Purchase date (needed for the age): ___
- Prior claims paid on this contract: ___
- Other: ___

**Rules checked:**

| Stage | Rules (E#) | Result | Why |
|---|---|---|---|
| 3 Coverage period | ___ | ___ | ___ |
| 4 Peril & exclusions | ___ | ___ | ___ |
| 5 Frequency & limits | ___ | ___ | ___ |
| 6 Evidence | ___ | ___ | ___ |
| 7 Red flags | ___ | ___ | ___ |
| 10 Authority | ___ | ___ | ___ |

**Payout math** (§4; this is the depreciation case):
1. C = ___
2. R = ___
3. V = ___ (show the depreciation: years, %, cap)
4. Repair or replace? ___ (70% of R = ___)
5. Price cap → ___
6. Deductible → ___
7. Per-claim limit → ___
8. Aggregate → payable ___

Is the contract now fulfilled (§1 table, "Replacement fulfills contract")? ___

The payout (46500) is less than the repair estimate (70000). Would you explain that in the letter? ___

**Outcome:** ___

**Claimant letter:**
> ___

**Internal file note:**
> ___

---

## Your gut check (most useful part)

1. Is there anything you'd want on record for an appeal or audit that you didn't have a place for above? yes any additional documentation or information provided in the appeal
2. Is there anything above you'd leave out because it's noise? no

## Where this differs from the fixtures' trace

Compared 2026-10-03 against `adjuster.trace/0` (`src/rules/schema.ts`). No reshape.

- **Rules listed: only the ones that apply** (Shane). The letter and file note show only the non-PASS rules; the stored trace keeps every check so an audit or appeal can show it ran. D32.
- **Appeal documents on record** (gut check 1): an appeal is a new superseding decision carrying the document version ids it relied on (D4, Phase 3). D33.
- **Nothing is noise** (gut check 2): the trace already holds every slot this page asks for: facts read with values, each rule's result, clause and text, the calc steps with input and output, outcome, reasons, payable, contract fulfilled, plan and ops versions, `asOf`.
- Not yet in the trace by design: who decided, authority tier and override reason are Decision columns (1.10), and document version ids arrive in Phase 3.

The three claim sections were left blank; 1.2 closed on the answers above.
