# Phase 3 — Evidence, authority, override, mock payment

Phase 2's pipeline gets the things a human does to a claim: documents arrive and are accepted, rejected or waived; facts are entered from them and attributed; an adjuster overrides or signs off within an authority limit; an approved amount is paid (mock) and a supplemental reopens the claim. Every one of these is a new row, never an edit, and `decisions:verify` still replays every engine decision. No UI, no rule authoring, no second product (Phase 4). No real payment provider, OCR or LLM, ever.

What already exists and this phase builds on: `docs.*` and `evidence.*` are input facts in `facts-v1` (the goldens supply them as plain values); E20, E21 and E22 pend on them and E23 refers above the system limit; ops carries `authority` (four tiers with powers) and `reminders` (10, 20, 30); `Decision` has the override columns and their all-or-none CHECK; `Claim.paymentStatus` and the twelve statuses with the `DECIDED` guards exist (D36, D38).

## Decide first (each becomes a `decisions.md` entry in 3.1)

Defaults are given; none is taken until 3.1 records it. The first three change the schema or the hashes, so they are Shane's to confirm.

1. **Do document version ids join `inputHash`?** D4 says a decision pins the versions relied on. Default: yes, as a sorted list in the hashed input, so replacing a document with an identical-status one is still a new input and supersedes. The alternative (a column outside the hash) makes EV-04 unverifiable by replay.
2. **What does verify check on an override row?** Today override rows skip the outcome/amount column check (D31) and nothing else is defined. Default: an override is checked for its link (the overridden engine decision exists, same claim, not itself an override), its reason, and its author's authority at `asOf` under the pinned ops version; it is never replayed. New failure code, named in 3.1.
3. **Who is at which tier?** The template has users and roles; the tiers are ops rule data. Default: a user-to-tier assignment table in the database (data, not a role name tested in code), read at decision time and stored on the override row.
4. **Is the appeal flow in this phase?** The PRD lists it as P1; D33 and D40 left it as a Phase 3 seam. Default: no. `UNDER_APPEAL` stays unexercised and the seam is noted again at the gate.
5. **Clearing a flag and waiving a document: override rows or their own records?** Default: a waiver is a document status (`WAIVED(reason, by)`, as the brief has it) that changes a `docs.*` fact and so re-adjudicates; clearing a flag is an override of the referral. GC-15 step 4 and step 6 are the two cases.
6. **What is "total incurred"?** Default: the sum of every amount paid or approved-and-unpaid on the claim, the current decision included. Deductibles are not incurred.

## Tasks

- [x] **3.1 Decisions and fixtures.** (D47 to D52; 63 fixtures) Record the six items above. The oracle then produces EV-01..EV-05, OV-01..OV-03, GC-05's sign-off (refer, then approve 77500), GC-11 and GC-15 (eight steps, each with its expected status, outcome, cents and document versions). `verify_fixtures.py` gains typed keys for each new kind and planted mutations fail it. Read GC-15's arithmetic against domain brief §11 by hand before freezing.
- [ ] **3.2 Document tables and store.** `Document` (claim, type) and `DocumentVersion` (SHA-256, uploader, uploaded at, source, status). Versions are insert-only by trigger; a new upload supersedes, nothing is overwritten or deleted (EV-03). `DocumentStore` interface with one local-disk implementation; the stored hash is checked on read.
- [ ] **3.3 Document status machine.** `REQUESTED → RECEIVED → ACCEPTED | REJECTED(reason)`, plus `SUPERSEDED` and `WAIVED(reason, by)`, as a transition table like PL-01, every move audited. Rejection reasons are the brief's five and are data. A waiver needs the `waive_documents` power.
- [ ] **3.4 Evidence facts.** A fact drawn from a document is entered by a person and stored with `documentVersionId`, `enteredBy`, `enteredAt`. The snapshot's `docs.*` and `evidence.*` values now come from these rows instead of `Claim.facts`; this is the `FactSource` seam, and the first code that changes a claim's inputs (the tests' raw `UPDATE "Claim"."facts"` goes). The decision row records the document versions it read (EV-04).
- [ ] **3.5 Evidence in the pipeline.** Missing documents pend and name each one (EV-01, EV-02); a claim already objectively deniable is not asked for documents. Accepting or waiving evidence re-adjudicates (EV-05) through `adjudicateClaim`, under D40's status rules.
- [ ] **3.6 No response.** Reminders at the ops rule set's `firstDay` and `secondDay`, then `CLOSED_NO_RESPONSE` at `closeDay`, all on the injected `asOf`. Not a denial: no decision row with an outcome of DENY, and the claim reopens when a document arrives (GC-11).
- [ ] **3.7 Authority.** A pure check: tier, power, total incurred on the claim, against the ops version in force. Tested on the total, never the increment.
- [ ] **3.8 Override and sign-off.** An override is a separate decision row with reason code and text, linked to the engine decision it overrides, which stays as written. Out of authority is rejected before anything is written (OV-01..OV-03). GC-05: the referral is signed off at 77500 by an adjuster. `decisions:verify` checks override rows as decided in item 2.
- [ ] **3.9 Mock payment.** `DECIDED → PAYMENT_PENDING → PAID → CLOSED` and `paymentStatus` `NONE → PENDING → PAID`, behind a `PaymentProvider` interface with one mock. The amount is the current decision's; a denial or an approval at 0 never pays; paying twice is a no-op. Paid amounts are what `d.sumPriorPaid` reads, so the aggregate erodes only by money paid.
- [ ] **3.10 Supplemental.** A supplemental reopens the same claim. The total is recomputed from the new facts, the difference is paid, the deductible is taken once, and authority is tested on the new total (GC-15 step 8: 170100 total, 85000 supplemental, senior adjuster).
- [ ] **3.11 Letters and notes.** The parts D42 left out: the documents a decision relied on, who decided and at what authority, the override reason in the note (never in the letter), and the pend letter's list of documents. Still text from stored rows only.
- [ ] **3.12 Seed and gate.** The seed adds GC-05's sign-off, GC-11 and GC-15 through the real services. `decisions:verify:test` OK in CI; TM-01..TM-09 still each fail with exactly their code, plus a tamper case for each new verify code.

**Exit criteria:** EV-01..EV-05, OV-01..OV-03, GC-05 (sign-off), GC-11 and GC-15 pass through the services. Every decision names the document versions it relied on. No document version, decision or payment record can be updated or deleted at the database. GC-15 can be narrated step by step from stored rows alone. `decisions:verify` is OK and CI enforces it. `rules:lint` finds no plan name, tier or threshold under `src/`.

## Carried in, not owned by a task

- From 3.1 (decisions.md, *Open after 3.1*): a breakdown claim with no photos or statement pends for ever on F7 and F10 (settle in 3.4); `missing` must name only unknown facts (engine change, 3.5); a supplemental not above what was paid cannot leave `DECIDED`; override reason codes and rejection reasons have no home yet (3.3, 3.8).

- Shane has not yet read the GC-12 file note as the auditor (the second half of the Phase 2 "before Phase 3" check). 3.11 changes the note, so read it before then.
- The database does not refuse a raw `UPDATE` of `Claim.status` (D38); only `transitionClaim` is meant to write it.
- A same-day ops version is accepted while no decision exists on or after that day, and whether a new decision may select a retired ops version is undecided (D37, D44).
- `tools/recompute_from_trace.py` refuses a `min_of` step because the trace stores no operands for it; no rule data uses it (D43).
