# Intake contract re-check

2026-10-20. Read-only: no code written. Compares `docs/prd-intake.md` with the repo as it stands after D90 (contract settled), D91 (label set), Intake phase 1 (`intake/electronics/schemas-v1.json`, `eval/`) and the saas-foundation v1.3.0 merge. The first check is `docs/intake-contract-check.md` (2026-10-14); its §5 became D90. Where the PRD and `docs/decisions.md` disagree, `docs/decisions.md` wins.

Models read: `prisma/schema/adjudication.prisma` (`Claim`, `Contract`, `Document`, `DocumentVersion`, `DocumentReview`, `DocumentWaiver`, `ClaimFact`, `Decision`), `rules/electronics/facts-v1.json`, `rules/electronics/ops-v3.json`, `src/adjudication/documents.ts` and `pipeline.ts`, `fixtures/ev/EV-05.json` (the facts each document carries), `intake/electronics/schemas-v1.json`.

**Bottom line.** D90 settled the field names and types. What is still open is the relationships: which extracted field becomes which fact, which run fed it, and what an automatic acceptance sets off. The biggest gap is §2 item 1. Under D90 as it stands, Intake hands the engine one fact, and no rule reads it.

## 1. Already settled (no action)

| PRD says | Repo / decision |
| --- | --- |
| `evidence_pending` | `PENDING_EVIDENCE`, derived by the pipeline; Intake never sets status (CLAUDE.md Intake rule 5) |
| New `claim_fact` with source, run id | `ClaimFact` unchanged; provenance in `ExtractionRun` / `ExtractedField` / `FieldCorrection` (D90 C) |
| Police report; `police_report_number`, `reported_incident_date`, `incident_type`, `damage_type`, `repairable`, `incident_date_matches_fnol` | Dropped (D90 B) |
| Receipt / police report / repair estimate / damage photo | `proofOfPurchase`, `repairEstimate`, `damagePhotos`, `incidentStatement`; electronics only (D90 A, D91 a) |
| 25 fields, 30 per type | 23 fields; 28 per type + 8 `other` (D91 a, b) |
| `repair_estimate_cents` fills the claim | Reviewer enters `claim.coveredRepairCents`; total is a hint (D90 F) |
| `conflicting_documents`; FNOL conflicts keep both | Review items, never facts (D90 G) |
| `purchase_date`, `purchase_price_cents` written to the claim | Contract facts, refused by `assertEnterable`; serial and price are cross-document checks only (D90 E) |
| Scores and Wilson intervals as fractions | Basis points; intervals in `eval/` (D90 H, Intake rule 8) |
| Generator writes labels | `eval/`, signed in `eval:signoff`, not `fixtures/` (D91 d) |
| SDK and PDF library | Approved at phase 3 (D90 I) |
| `claude-haiku-4-5-20251001`, `claude-sonnet-5-5` | Verify against the API docs at phase 3; the current Haiku is `claude-haiku-5-5` |

## 2. Open mismatches

Kind: **F** field, **T** type, **R** relationship, **A** assumption. "Rec" is my recommendation; nothing is applied until you sign.

| # | Kind | PRD says | Repo has | Proposed resolution |
| --- | --- | --- | --- | --- |
| 1 | R | Goal 5: accepted fields flow into claim facts; capstone: "09 decides in one pass" | `schemas-v1.json` has **no field-to-fact mapping** (D90 H says it is data). Of the 23 fields, only `purchase_date` → `evidence.proofOfPurchaseDate` maps cleanly, and **no rule reads that fact**. The facts documents carry that rules do read (EV-05: `coveredRepairCents`, `serialMatchesContract`, `estimateFromNetwork`, `estimatorIsPayee`, `photoMetaDateBeforeLoss`, `documentHashOnOtherClaim`, `accountChanged`) are none of them extracted fields | **Rec:** add `intake/electronics/mapping-v1.json` with `purchase_date` → `evidence.proofOfPurchaseDate`, and derive `evidence.estimateFromNetwork` from `shop_name` against a network-shop list held as data under `intake/` (a validator, `docs/decisions.md` entry). Every other field is a **hint** shown to the reviewer. Restate Goal 5 and the capstone in the PRD so they don't promise more than that. *Alt:* mapping only, no derivation; Intake becomes a review aid that hands over almost no facts |
| 2 | R | `serial_matches_claim` derived by Intake | `claim.serialMatchesContract` means "matches the **contract**". No contract serial exists (D90 E), so document-to-document agreement cannot prove it, yet E5 pays on `true` | **Rec:** Intake never writes `claim.serialMatchesContract`. A serial disagreement across documents is a review item; the reviewer still enters the fact |
| 3 | F | (silent) | `evidence.photoMetaDateBeforeLoss` comes from photo metadata (capture date). No extraction field holds it, the model is not shown metadata, and `eval:signoff` strips metadata from the real photos on purpose | **Rec:** out of Intake scope; it stays human-entered. Seam: if wanted later, code reads the capture date at ingest, never the model |
| 4 | R | P0-9: the fact snapshot names the run that fed it | Provenance joins on `(documentVersionId, factId)` (D90 C). A version with two passes or a re-extraction has several runs, so the join is ambiguous | **Rec:** one insert-only `IntakeHandoff` row per version (`versionId` unique, `runId`, actor), written in the same transaction as the acceptance. It also gives item 6 its idempotence |
| 5 | A | Corrections are append-only; the model value is never overwritten | `ClaimFact @@unique([documentVersionId, factId])`. Once a version is accepted, a later correction cannot be a second document-linked row | **Rec:** before acceptance, a correction is a `FieldCorrection` row and the final value goes in with the acceptance. After acceptance, `enterFact` (a person-entered row; the latest wins) plus a `FieldCorrection` that names the version. No change to `ClaimFact` |
| 6 | A | P0-7: replaying a handoff writes nothing | `reviewDocument` refuses a second review of a version (throws `gone`); it is not a no-op | **Rec:** Intake checks `IntakeHandoff` / `DocumentReview` first and returns. No change to 09 |
| 7 | A | P0-1: same sha256 returns the existing document; no new run | Every upload is a new `DocumentVersion` even for identical bytes, and it supersedes an accepted one (D51c). Only the byte store dedupes | **Rec:** leave 09 alone. Intake makes no model call when the same sha256 was already extracted under the same prompt, schema and model versions; it records a run that reuses the earlier fields |
| 8 | F | `document`: mime type, page count, text-layer flags | `DocumentVersion` has `sha256`, `source`, `version`, `uploadedBy` only. The grounding signal and the P0-1 size/page refusals need the missing fields | **Rec:** a fourth insert-only table `DocumentInspection` (keyed by sha256: mime, bytes, pageCount, textLayerPages) in `intake.prisma`. `DocumentVersion` untouched |
| 9 | R | P0-2: classification assigns the type | An upload must name its slot (`docs.<type>`) before it exists; there is no `other` slot | **Rec:** classification only checks the uploader's tag. `other` or a disagreement → review; the reviewer rejects with `wrong_document` (exists) and the claimant uploads to the right slot (D90 item 5, made explicit) |
| 10 | A | P0-6: only fields required for the claim's peril block | Which documents a peril needs is in ops rules (`ops-v3` `docs.*` rows), and Intake may not read rule sets (Intake rule 5). `schemas-v1.json` has no `required` flag, so D90 D's "every required field passes" has nothing to read | **Rec:** add `required` per field per type in the schema data (not per peril). Whether a document is needed stays the engine's call (it PENDs) |
| 11 | A | P0-6: "mark unreadable" sends the claim back with a re-upload request naming the field | Rejection reasons are fixed rows per product (`illegible`: "we could not read it"); letters render from stored reasons only | **Rec:** unreadable on a required field → reject with `illegible` through the pipeline. The field name goes in `FieldCorrection` and the audit event, not the claimant letter |
| 12 | A | Rules can route on `source = human_corrected` and on `serial_matches_claim`; the capstone shows `human_corrected` in the decision trace | The engine reads facts only; source is not a fact, not in the snapshot and not in the trace (engine purity, letters from the stored trace) | **Rec:** drop both rule examples and restate the capstone: source shows on the claim page by join, not in the trace. A source-as-fact would be a vocabulary change (decision entry plus fixture). Not proposed |
| 13 | R | Auto-accept is an acceptance | `acceptEvidence` accepts *and* adjudicates (D56). An auto-accept through it writes a decision row with no person involved, and under item 1 that row will almost always be a `PEND` | **Rec:** auto-accept calls `reviewDocument` (the document move only) as the named system actor, a fixed uuid kept in `intake/` data. The decision runs at the next person-driven `acceptEvidence`. *Alt:* `acceptEvidence`, accepting automatic `PEND` rows |
| 14 | T | `field_score`, `review_task` tables; "state-machine module" | D90 names three tables; Intake has no state set | **Rec:** no `field_score` table (signals are columns on `ExtractedField`, score computed by pure `intake/score`). No `review_task` table: the queue is versions with a run and no `DocumentReview`. Intake states get a pure transition function, like `assertDocumentMove` |
| 15 | A | PRD header: "queued, not started"; the "Read this first" table | Phase 1 is built; that table is the pre-D90 list | **Rec:** rewrite the PRD header to point to D90, D91 and this file; mark the table historical |

## 3. To sign

Each line becomes a numbered entry in `docs/decisions.md` when signed (D92 onward). Items 1, 2, 12 and 13 change what Intake is for; the rest are mechanics.

| # | Decision | Rec |
| --- | --- | --- |
| 1 | Facts Intake hands over | `proofOfPurchaseDate` + `estimateFromNetwork` via a shop list; the rest are hints; Goal 5 restated |
| 2 | `serialMatchesContract` | Never written by Intake |
| 3 | Photo metadata date | Out of scope; human-entered |
| 4–7 | Handoff row, corrections, idempotence, sha dedupe | As in §2 |
| 8 | `DocumentInspection` table | Yes |
| 9 | Classification checks, never moves | Yes |
| 10 | `required` per field in schema data | Yes |
| 11 | Unreadable → `illegible` rejection | Yes |
| 12 | Source-based rules and trace display | Dropped; source on the claim page |
| 13 | Auto-accept path | `reviewDocument`, system actor uuid in `intake/` |
| 14 | No `field_score` / `review_task` tables | Yes |
| 15 | PRD header refresh | Yes |
