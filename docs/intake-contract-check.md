# Intake contract check

2026-10-14. Read-only: no code written. Compares `docs/prd-intake.md` with the repo as built (Phase 4 closed). Where the PRD and `docs/decisions.md` disagree, `docs/decisions.md` wins. Each item in §3 and §4 is a decision for Shane before Intake phase 1; the "Proposed" lines are defaults, not choices.

## 1. Stack and conventions in use

- TypeScript on saas-foundation v1.2.0: Next.js 16, Prisma 7 (schema split under `prisma/schema/`, adjudication tables in `adjudication.prisma`), PostgreSQL 17, vitest, Playwright, port 4900. Python only in `tools/`.
- No Anthropic SDK and no PDF library in `package.json`. Both need "ask before adding dependencies".
- Services take a `Db` and write with hand-written SQL in one statement (CTEs), audit event in the same statement. Immutability is a trigger in a Prisma migration.
- Money is `...Cents`, rates `...Bps`, integers only. Everything hashed goes through the one canonical-JSON serializer (D5). `src/` may hold no float and no plan identifier (`rules:lint` greps for both).
- Fixtures under `fixtures/` are frozen and built by `tools/build_fixtures.py`. Rule data is JSON under `rules/<product>/`, two products: electronics and furniture.
- Evidence is already built: `Document` (one per claim and type) → `DocumentVersion` (sha256, source, version) → `DocumentReview` (accepted or rejected with a product-scoped reason) or `DocumentWaiver`; `ClaimFact` (insert-only; latest row wins); services `uploadEvidence`, `acceptEvidence`, `waiveEvidence`, `reviewDocument`, `enterFact`, `readEvidence`.
- The dictionary decides which document types and which facts exist per product (`docs.<type>`, `rulesFor` in `src/adjudication/documents.ts`).

## 2. Contract points and fact names

| PRD | Repo | Verdict |
| --- | --- | --- |
| Claim waits in `evidence_pending` until required documents and facts are accepted | Status is `PENDING_EVIDENCE` and is *derived*: a `PEND` decision sets it, and a missing fact already produces a `PEND` (D9, D51f). Nothing sets it by timing | rename; Intake should not manage status at all |
| Payload: `claim_fact` rows with source, run id, correction id | `ClaimFact(factId, value, documentVersionId \| enteredBy)`. No source or run column | missing (see §3.2) |
| Facts enter only by confidence or a person's correction | Facts enter through `reviewDocument(facts)` at acceptance, or `enterFact` for facts no document carries | match, if Intake feeds these |
| `purchase_date`, `purchase_price_cents` | `product.purchaseDate` and `product.purchasePriceCents` are **contract** facts, stored on `Contract` and refused by `enterFact`/`reviewDocument` (`id in pin.facts`) | cannot write. A receipt's date goes to `evidence.proofOfPurchaseDate` (exists). Price has no fact (§4.3) |
| `device_serial` | No serial fact anywhere in either dictionary, and none on `Contract` or in `Claim.facts` | missing (§4.1) |
| `serial_matches_claim` (derived by Intake) | `claim.serialMatchesContract` (bool input; comment "human-entered; the vocabulary has no fact-to-fact comparison") | rename; needs a reference serial that does not exist |
| `incident_date_matches_fnol` | No fact. `claim.dateOfLoss` is an input filed at FNOL | missing; drop |
| `police_report_number`, `reported_incident_date`, `incident_type` | No fact; no police-report document type. Electronics perils are breakdown, adh, battery_degradation, other: no theft. Furniture has none either | missing; drop (§3.4) |
| `repair_estimate_cents` | `claim.coveredRepairCents` = estimate **minus non-covered line items** (C). Estimate total is not C | cannot work as written (§4.2) |
| `repairable`, `damage_type` | No fact. `lookup.path` is a lookup, not an input | missing; drop |
| Doc types: receipt, police report, repair estimate, damage photo | Electronics: `proofOfPurchase`, `repairEstimate`, `damagePhotos`, `incidentStatement`, `secondEstimate`, `transferProof`. Furniture: `proofOfPurchase`, `photos`, `incidentStatement`, `technicianReport` | rename three; police report has no home; furniture is a second type set |
| `other` goes straight to review | No such type. A wrong-type upload is a version on the wrong `Document` | missing (§3.5) |
| Two accepted documents of one type can disagree; `conflicting_documents` | `Document` is unique on (claim, type); a new upload supersedes the old one, accepted or not (D51c) | cannot occur as written (§4.4) |
| Conflicts with FNOL: both kept, mismatch fact set, no winner | The snapshot is flat `factId → value`; filed `Claim.facts` first, then entered facts, **later wins** (D55d). A document fact overrides the filed one silently | cannot work as written (§4.5) |
| Reproducibility: decision stores the facts snapshot | `Decision` hashes facts and `documentVersions` (D47); `decisions:verify` replays them | match |
| Direction: Intake never reads rule sets | Intake must read the dictionary (document types, fact types) to validate; dictionary only, not rules or decisions | match with a narrowed reading |
| Reviewer confirms fields | `reviewDocument` is the reviewer step; acceptance carries the facts | match; same step (§3.3) |
| Eval label set, "generator" | Fixtures are frozen and Python-built | needs a stated rule (§3.7) |
| Confidence scores, Wilson intervals | `src/` allows no float | conflict (§4.6) |
| Model ids `claude-haiku-4-5-20251001`, `claude-sonnet-5-5` | Current family is Claude 5 (haiku-5-5, sonnet-5-5) | verify in phase 3 against the API docs |

## 3. Changes 09 would need, smallest first

1. **None to the engine, rules or fixtures.** Intake feeds `uploadEvidence` → `acceptEvidence(facts)`; `decisions:verify` and the frozen fixtures are untouched.
2. **Provenance without touching `ClaimFact`.** `ClaimFact` has no source column and `@@unique([documentVersionId, factId])` allows one row per fact per version, so a correction cannot be a second row on the same version. Proposed: new Intake tables (`ExtractionRun`, `ExtractedField`, `FieldCorrection`, insert-only by trigger) in their own `prisma/schema/intake.prisma`, linked by `documentVersionId`. The value passed to `acceptEvidence` is the final one (model's or the reviewer's); `source` = `auto_accepted | human_confirmed | human_corrected` is read by joining on `(documentVersionId, factId)`. Not taken: adding columns to `ClaimFact` (a core table of the evidence phase; D55 is settled).
3. **Who accepts an auto-accepted document.** `DocumentReview.reviewedBy` null already reads as "no person". Proposed: Intake acts as a named system actor with a fixed uuid, recorded in the audit event, and only for documents whose required fields all pass. Needs your call: this is a machine approving evidence.
4. **Document and fact scope.** Proposed: electronics only for phase 1 (`proofOfPurchase`, `repairEstimate`, `damagePhotos`, `incidentStatement`), furniture later, because the extraction schema and the fact mapping are per product. Drop police report and `damage_type`, `incident_type`, `repairable`, `police_report_number`; they feed no rule.
5. **`other` and wrong-type.** A reclassified upload is a new version on the right `Document`. Proposed: wrong-type needs no repo change; the old version stays and is rejected with reason `wrong_document` (exists).
6. **Schemas as data.** Per-type extraction schemas, field→fact mapping and the review threshold are plan/product-shaped, so they live as JSON under `intake/` (like `rules/`), not in `src/`, and `rules:lint` is extended to cover them. Adding a field is a `docs/decisions.md` entry plus a label.
7. **Eval labels.** `eval/` is separate from `fixtures/`: labels are signed by hand, the generator is seeded and committed, and `tools/` Python may build documents but stays an oracle that `src/` never imports. State this in `docs/decisions.md` first.
8. **Dependencies to approve before phase 3:** Anthropic SDK, a PDF-to-image library. Phase 1 needs a PDF writer for the generator (can be Python in `tools/`).

## 4. Where the PRD cannot work as written

1. **No reference serial.** `claim.serialMatchesContract` is "serial on the estimate equals the contract's", but the contract holds no serial and FNOL files none. Intake has nothing to compare with. Options: add `product.serial` to the contract facts (a dictionary entry, a seed change and a new plan version, so frozen fixtures move), or compare receipt to estimate to photo (cross-document), which proves consistency, not identity with the covered device.
2. **Estimate total is not the covered repair cost.** C is the estimate minus non-covered line items, a plan judgement (domain brief §4). A model total cannot fill `claim.coveredRepairCents`. Options: Intake extracts line items and the reviewer classifies covered or not (a bigger review screen), or Intake feeds nothing and the reviewer still enters C via `enterFact` with the extracted total shown as a hint.
3. **Receipt price has no fact.** Domain brief §6 says "price equals contract purchase price", but the dictionary has no fact-to-fact comparison (the same reason as item 1). The check is made by a person. Same shape of options as item 1.
4. **`conflicting_documents`.** Not reachable: the second upload supersedes the first (D51c). The real conflict is cross-type (receipt serial vs estimate serial vs photo serial). Proposed: a cross-type disagreement is a review-queue item raised by Intake validators, never a fact.
5. **FNOL conflicts.** Later row wins, so "keep both, pick no winner" would need the engine to read two values for one fact. Proposed: where a document fact differs from a filed one, the reviewer sees both and the document wins only on acceptance, recorded in the audit event. No new fact.
6. **Floats.** Confidence signals and Wilson intervals are fractions. Proposed: scores in basis points (integers), intervals computed in `eval/` outside `src/`, and `rules:lint` run over `src/intake` only.

## 5. Decisions needed before phase 1

| # | Decision | Proposed |
| --- | --- | --- |
| A | Product scope for Intake | Electronics only; furniture later |
| B | Drop police report and the five facts with no rule | Yes |
| C | Provenance in Intake tables, not on `ClaimFact` | Yes |
| D | May Intake auto-accept a document as a system actor | Yes, audited, only when every required field passes |
| E | Serial and price comparison (§4.1, §4.3) | Cross-document consistency only; a contract serial is out of scope |
| F | Covered repair cost (§4.2) | Reviewer enters C; the extracted total is a hint |
| G | Cross-document conflicts (§4.4, §4.5) | Review items, not facts |
| H | Confidence in bps; schemas and threshold as data under `intake/` | Yes |
| I | Dependencies: Anthropic SDK, PDF-to-image | Approve at phase 3, not now |
