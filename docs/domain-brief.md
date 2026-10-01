# Adjuster — Domain Brief (senior claims adjuster review)

The source for rule data and fixtures. All money is integer cents. Items marked **[verify]** are simplifications or conventions that are not universal; each has an entry in `decisions.md`. Plan terms, thresholds and percentages here are invented for the sample business — they are teaching parameters, not industry figures.

## 1. Product scope

Consumer electronics and appliance service contracts: mechanical/electrical breakdown plus accidental damage from handling (ADH). Chosen because eligibility is objective and parameter-heavy (dates, counts, perils, limits). Left out: theft/loss, liability, subrogation, reserving, premium/refund accounting, servicer dispatch, state form variations.

| Term | Essential | Plus | Premier |
|---|---|---|---|
| Term | 24 months | 36 months | 36 months |
| Waiting period | 30 days | 30 days | 14 days |
| Perils | Breakdown | Breakdown + ADH | Breakdown + ADH + battery below 80% capacity |
| Deductible | 5000 | 7500 | 2500 breakdown / 9900 ADH |
| Per-claim limit | 50000 | 100000 | 200000 |
| Aggregate limit | 100000 | 200000 | 400000 |
| Replacement basis | ACV | ACV | Replacement cost |
| Claim frequency | 2 per 12 months | 2 ADH per 12 months | 3 ADH per 12 months |
| Replacement fulfills contract | Yes | Yes | No |

- **Exclusions, all tiers:** cosmetic damage, pre-existing conditions, consumables and accessories, software/data, unauthorized repair or modification, commercial use, intentional damage or abuse, loss/theft, failures covered by manufacturer warranty or recall, external events (fire, flood, pests, surge).
- **Limit of liability, all tiers:** no claim settles above the product purchase price.
- **Depreciation is a simplification [verify]:** real service contracts more often replace with "like kind and quality" or buy out capped at purchase price. A formal ACV schedule is more a property-insurance concept, kept here as a teaching parameter.

## 2. Adjudication sequence

| # | Stage | Decides | Outcomes |
|---|---|---|---|
| 1 | FNOL intake | Is this a claim; is it a duplicate? | Open / duplicate → refer |
| 2 | Contract verification | Contract exists; holder and product match | Pass / **stop** (not found) / refer (mismatch) |
| 3 | Coverage period | In force on date of loss, past waiting period | Pass / deny |
| 4 | Peril and exclusions | Peril covered; any exclusion applies | Pass / deny / refer (judgment exclusions) |
| 5 | Frequency and limits | Claim count and aggregate remaining | Pass / deny |
| 6 | Evidence sufficiency | Required documents accepted | Pass / pend |
| 7 | Red flags | Fraud indicators | Flags → refer |
| 8 | Valuation | Repair or replace; loss amount | Amount |
| 9 | Deductible and limits | Net payable | Amount (may be 0) |
| 10 | Authority | Who may approve | Auto / refer up |
| 11 | Decision and explanation | Final decision | Approve / partial / deny |
| 12 | Payment and closure | Pay and close | Paid → closed |

- Short-circuit only on stage 2 "not found". Stages 3–5 all run and collect every reason: adjusters cite all known denial grounds (in some jurisdictions grounds omitted from the denial may be waived later **[verify]**).
- Valuation never runs on a denied claim; the amount is null, not 0.
- Outcome precedence: objective deny > pend for evidence > refer > approve or partial.
- Don't request documents for a claim already objectively deniable.
- Judgment exclusions (pre-existing, abuse) refer with a recommendation. Many shops require a human on every denial **[verify]**, so `auto_deny_enabled` is an ops parameter.

## 3. Eligibility rules

Class C = contractual (plan version, pinned at contract purchase). Class O = operational (ops version, by adjudication date).

| ID | Class | Rule (parameters) | Outcome | Claimant reason text |
|---|---|---|---|---|
| E1 | C | Contract active on date of loss | Deny | "Your contract was not active on the date of loss." |
| E2 | C | Date of loss within term | Deny | "The loss occurred outside your coverage term ({start}–{end})." |
| E3 | C | Date of loss ≥ N days after start (N per plan/peril) | Deny | "The loss occurred during the {N}-day waiting period." |
| E4 | C | Reported within N=30 days of date of loss | Refer | "Your claim was reported more than {N} days after the loss and needs review." |
| E5 | O | Claimed serial/IMEI matches contract | Refer | "The product identified does not match the covered product." |
| E6 | C | Peril is in the plan's covered perils | Deny | "Your plan does not cover {peril}." |
| E7 | C | Cosmetic only, function unaffected | Deny | "Cosmetic damage that does not affect function is excluded." |
| E8 | C | Pre-existing condition | Refer (recommend deny) | "The condition existed before coverage began." |
| E9 | C | Consumable or accessory (Premier: battery covered below N=80%) | Deny | "Batteries, consumables and accessories are excluded." |
| E10 | C | Unauthorized repair/modification (declared → deny; suspected → refer) | Deny / refer | "Repairs or modifications by a non-authorized servicer are excluded." |
| E11 | C | Commercial or rental use | Deny | "Products used commercially are excluded." |
| E12 | C | Intentional damage, abuse, misuse | Refer | "Damage from abuse or intentional acts is excluded." |
| E13 | C | Breakdown within manufacturer warranty (N months) or open recall | Deny | "This failure is covered by the manufacturer's warranty; please contact them." |
| E14 | C | Product lost, stolen or unavailable for inspection | Deny | "Loss and theft are not covered." |
| E15 | C | At most N claims per rolling 12 months (per peril and plan) | Deny | "You have reached the limit of {N} claims in 12 months." |
| E16 | C | Aggregate remaining above 0 | Deny | "Your contract's total limit has been reached." |
| E17 | O | Duplicate: same contract and peril, date of loss within N=7 days | Refer | "This appears to duplicate claim {id}." |
| E18 | C | Software, data or virus issue | Deny | "Software and data issues are excluded." |
| E19 | C | External cause (fire, flood, pests, surge) | Deny | "Damage from external events is excluded." |
| E20 | O | Required documents accepted for the claim type | Pend | "We need: {list}." |
| E21 | O | Estimate from a network servicer, else second estimate | Pend | "Please provide an estimate from an authorized servicer." |
| E22 | O | Claimant is contract holder or registered transferee | Pend | "We need proof the contract was transferred to you." |
| E23 | O | Payable above auto-approve limit (50000) | Refer | Internal only |

## 4. Payout order of operations

1. **Covered repair cost C** = estimate minus non-covered line items.
2. **Replacement value R** = current catalog cost of like kind and quality.
3. **Basis V** = R on a replacement-cost plan. On an ACV plan, V = R × (1 − 20% × full years since purchase), depreciation capped at 60%.
4. **Repair or replace:** if C > 70% × R, replace and loss L = V. Otherwise repair and L = C.
5. **Limit of liability:** L = min(L, purchase price).
6. **Deductible:** L = max(0, L − deductible).
7. **Per-claim limit:** L = min(L, per-claim limit).
8. **Aggregate:** payable = min(L, aggregate limit − prior paid).
9. **Erosion:** only the amount paid erodes the aggregate; the deductible does not.

Deductible before limit is the usual convention unless the contract says otherwise **[verify]**; the order is rule data. Percentages in basis points, integer math, round half-up to the cent.

Payout fixtures (all checked by hand):

| ID | Plan | Inputs | Math | Payable |
|---|---|---|---|---|
| PAY-A repair | Plus | Price 120000, R 110000, C 30000 | 30000 ≤ 77000 → repair; 30000 − 7500 | **22500** |
| PAY-B replace | Premier, breakdown | Price 90000, R 80000, C 60000 | 60000 > 56000 → replace at 80000; − 2500 | **77500** |
| PAY-C below deductible | Essential | C 4000, R 60000 | 4000 − 5000, floored at 0 | **0** (approved, not denied) |
| PAY-D aggregate | Plus | Price 150000, R 140000, C 60000, prior paid 170000 | 60000 − 7500 = 52500; remaining 30000 | **30000** (partial; contract fulfilled) |
| PAY-E depreciation | Plus | Price 80000, R 90000, age 2 years, C 70000 | 70000 > 63000 → replace; ACV 90000 × 60% = 54000; − 7500 | **46500** |
| PAY-F price cap | Premier, ADH | Price 100000, R 130000, total loss | min(130000, 100000) − 9900 | **90100** |
| PAY-G per-claim cap | Essential | Price 120000, R 100000, C 62000 | 62000 ≤ 70000 → repair; − 5000 = 57000; cap 50000 | **50000** (partial) |
| PAY-H denial | Essential | Cracked screen (ADH) | Valuation not run | **null** |

Note on PAY-E: an ACV replace can pay less than the repair would have cost (46500 against a 70000 estimate). That follows from the rules as written; accepted in decisions D26.

## 5. Explanations

| | Claimant letter | Internal file note |
|---|---|---|
| Contains | Decision; every reason in plain language; contract clause cited; facts relied on; amount math line by line; what to do next (appeal, missing documents) | Rule IDs and versions; inputs; each rule's result with values; document version IDs relied on; flags; who or what decided; authority level; override reason |

Bad explanations: "not covered under your plan" with no clause · one reason when three apply · an amount with no math · no stated facts (which date was used) · jargon or fraud suspicion shown to the claimant · text regenerated later from current rules.

- **Approve:** "Approved. Your Plus contract covers mechanical breakdown (§3.1). Loss date 2026-03-10 is within your term. Repair estimate $300.00 less $75.00 deductible (§5.2) = **$225.00** payable to the servicer."
- **Partial:** "Approved in part. Covered repair $600.00 less $75.00 deductible = $525.00. Your contract's total limit is $2,000.00 (§6.1), of which $1,700.00 was previously paid, so we are paying the remaining **$300.00**. The contract is now fulfilled."
- **Deny:** "Denied for two reasons. (1) The loss on 2026-07-14 occurred after your contract ended on 2026-07-04 (§2.1). (2) The damage described, surface scratches with the device fully functional, is cosmetic and excluded (§4.3). You may appeal by…"
- **Refer (internal):** "Referred, no decision. E1–E22 pass. Flags: F2 (second claim on this serial in 60 days), E23 (payable 85100 above auto limit 50000). Calculated payable 85100. Needs adjuster tier or above."

## 6. Evidence documents

| Document | Breakdown | ADH | Adjuster checks |
|---|---|---|---|
| Proof of purchase | Required | Required | Date on or before contract start; product and serial match; price equals contract purchase price |
| Repair estimate or diagnostic | Required | Required | Network servicer; itemized; dated after date of loss; serial match; cause consistent with peril |
| Damage photos | Optional | Required | Serial/IMEI visible; damage consistent with description; legible |
| Incident statement | Optional | Required | Date and cause consistent with FNOL |
| Transfer proof | If transferee | If transferee | Names match |

- Statuses: `REQUESTED → RECEIVED → ACCEPTED | REJECTED(reason)`, plus `SUPERSEDED`, `WAIVED(reason, by)`. Rejection reasons: illegible, wrong document, serial mismatch, date inconsistent, incomplete.
- Missing evidence: pend; reminders at day 10 and 20; `CLOSED_NO_RESPONSE` at day 30 (all parameters). Not a denial; reopens when documents arrive.
- Never overwrite or delete an upload. A new upload is a new version that supersedes. Store hash, uploader, timestamp, source. Each decision records the exact document versions relied on.

## 7. Authority, override, states

| Tier | Approve up to (total incurred on the claim) | Extra powers |
|---|---|---|
| System | 50000 | None |
| Adjuster | 100000 | Clear flags, waive documents |
| Senior adjuster | 250000 | Decide appeals |
| Claims manager | Unlimited | Ex gratia, rule publishing |

- Authority is tested on total incurred, not the incremental payment, so supplements cannot be split to stay under a limit.
- Overrides need a reason code and free text, stored alongside the engine's result, never in place of it.
- No one decides an appeal of their own decision.
- A supplemental claim reopens the same claim with a new decision; the deductible is not taken twice.

Claim status (separate from decision outcome and payment status):
`OPEN → PENDING_EVIDENCE ⇄ IN_REVIEW → REFERRED → DECIDED → PAYMENT_PENDING → PAID → CLOSED`
Also legal: `IN_REVIEW → DECIDED` · `REFERRED → PENDING_EVIDENCE` · `PENDING_EVIDENCE → CLOSED_NO_RESPONSE` · any pre-decision state `→ WITHDRAWN` · `DECIDED(denied) → UNDER_APPEAL → DECIDED` · `DECIDED(denied or approved at 0) → CLOSED` · `CLOSED | CLOSED_NO_RESPONSE → REOPENED → IN_REVIEW`.

## 8. Rule change governance

- An analyst or manager drafts; a different person approves; the version publishes with an effective-from date. Published versions are immutable.
- **Contractual rules** (perils, exclusions, deductible, limits, waiting period, depreciation) are pinned by **contract purchase date** — the plan version the customer bought. The contract is the bargain; coverage cannot change after the sale. Date of loss decides whether the contract was in force, not which terms apply.
- **Operational rules** (authority, red flags, evidence checklist, reminders) apply by **adjudication date**.
- Common mistakes: latest rules applied to everything; pinning by date reported; editing a rule in place; not storing the version on the decision.
- Re-adjudication is never silent. A new decision arises only by reopen, appeal, supplement, or a manager-approved remediation batch. Paid claims are never clawed back.
- Dry-run a draft against historical claims and show decision and amount differences before the approver signs.

## 9. Red flags (refer only; never deny; never shown to the claimant)

| ID | Indicator |
|---|---|
| F1 | Date of loss within 7 days after the waiting period ends |
| F2 | Two or more claims on the same serial within 60 days |
| F3 | Proof of purchase dated after date of loss |
| F4 | Contract bought more than N days after the product, with a claim soon after |
| F5 | Estimate at or above 95% of the per-claim limit, or just under the replace threshold |
| F6 | Same claimant, address or payee across three or more contracts with claims |
| F7 | Photo metadata date before date of loss, or the same document hash on another claim |
| F8 | Estimate from a non-network servicer who is also the payee |
| F9 | Date of loss within the last 30 days of the term |
| F10 | Claimant's account of cause changed between FNOL and statement |

## 10. Traps, ranked

1. Applying current rules to old contracts.
2. Stopping at the first denial reason.
3. Treating "$0 payable" as a denial (approval at 0 vs. denial with null amount).
4. Regenerating explanations on read.
5. Using date reported or today instead of date of loss for coverage checks.
6. Denying for missing evidence instead of pending.
7. Mutating a decision on override, appeal or supplement.
8. Money order errors: deductible twice on a supplement, purchase-price cap forgotten, aggregate eroded by gross rather than paid.
9. Fraud flags auto-denying or leaking into letters.
10. Conflating claim status, decision outcome and payment status; checking authority per payment rather than per claim total.

## 11. Golden claims (GC-01..GC-15)

| GC | Plan | Facts | Decision | Reasons |
|---|---|---|---|---|
| 01 | Essential | Washer motor fails month 8; repair 30000; documents complete | Approve 25000 | All pass; 30000 − 5000 |
| 02 | Essential | Cracked phone screen | Deny (null) | E6 |
| 03 | Plus | Laptop failure on day 12 | Deny | E3 |
| 04 | Plus | Loss 10 days after term end; scratches only | Deny | E2 + E7, both cited |
| 05 | Premier | PAY-B (TV) | Refer → approve 77500 on adjuster sign-off | Replace threshold; E23 |
| 06 | Essential | PAY-C | Approve 0 | Below deductible |
| 07 | Plus | PAY-D | Partial 30000 | Aggregate; contract fulfilled |
| 08 | Plus | PAY-E | Approve 46500 | Replace + depreciation; contract fulfilled |
| 09 | Plus | Third ADH claim in 12 months | Deny | E15 |
| 10 | Premier | Estimate serial differs from contract serial | Refer | E5 |
| 11 | Plus | No proof of purchase; no response for 30 days | Pend → closed, no response | E20; not a denial |
| 12 | Premier | Receipt dated after date of loss; loss on day 16 | Refer | F3 + F1 |
| 13 | Essential | PAY-G | Partial 50000 | Per-claim cap |
| 14 | Essential | Declared prior third-party repair; used in a café | Deny | E10 + E11 |

**GC-15 capstone (Premier laptop, price 180000, R 190000; one prior breakdown claim 45 days earlier, paid 20000):**

1. FNOL: liquid spill on day 200, reported day 202.
2. Pend: photos and statement accepted; estimate missing (E20). Reminder sent.
3. Evidence: estimate of 95000 arrives from a non-network servicer, so E21 pends for a second estimate.
4. Override: adjuster waives E21 ("No network servicer within 50 miles; estimate itemized and consistent with parts catalog").
5. Adjudication: 95000 ≤ 133000 → repair. 95000 − 9900 = **85100**.
6. Referral: E23 (above 50000) and F2. Adjuster clears F2 ("unrelated failure, network-repaired") and approves within 100000 authority.
7. Payment: 85100 paid; claim closed.
8. Supplemental: teardown finds motherboard damage, +50000. Covered repair is now 145000 > 133000 → replace. New total min(190000, 180000) − 9900 = 170100; less 85100 already paid = supplemental **85000**. Total incurred 170100 exceeds adjuster authority, so a senior adjuster approves. Aggregate remaining 400000 − 20000 − 170100 = 209900; the contract continues (replacement does not fulfill a Premier contract).
