import { tierOf } from '@/adjudication/authority';
import { type ClaimStatus, transitionClaim } from '@/adjudication/claim-status';
import { type Db, inputHashOf, loadVersions, recordDecision } from '@/adjudication/decisions';
import { type DocumentStore, OutOfAuthorityError, readDocumentStatuses, readEvidence, reviewDocument, type Upload, uploadDocument, type UploadedVersion, waiveDocument, type Waiver } from '@/adjudication/documents';
import { checkAuthority, powerToOverride } from '@/rules/authority';
import type { Snapshot } from '@/rules/derive';
import { selectVersions } from '@/rules/select';

// The pipeline (task 2.6, D39): claim → contract → versions → frozen snapshot → engine → decision and status move,
// all in one transaction. `db` must be one connection (a `pg` Client, never a Pool), or BEGIN and COMMIT would
// land on different sessions. No decision is written without a contract and both versions: the claim is referred.
// Running a claim again (task 2.7, D40) returns its current decision when the input is unchanged, and supersedes it otherwise.
// Filing a claim, accepting a document and waiving one each decide the claim in the transaction that makes the change
// (task 3.5, D51a, D51d, D56), so a change the status table will not let be decided is not made at all.
// An upload decides nothing, but one on a claim closed for no response reopens it in the same transaction (task 3.6, D51i).
// A person's sign-off of a referral is a second row beside the engine's, never a change to it (task 3.8, D48, D59).

const STATUS_FOR: Record<string, ClaimStatus> = { APPROVE: 'DECIDED', PARTIAL: 'DECIDED', DENY: 'DECIDED', PEND: 'PENDING_EVIDENCE', REFER: 'REFERRED' };

export type PipelineResult =
  | { decisionId: string; outcome: string; claimStatus: ClaimStatus }
  | { error: 'CONTRACT_NOT_FOUND' | 'NO_EFFECTIVE_VERSION'; detail: string; decisionId: null; claimStatus: 'REFERRED' };

type By = { userId: string | null };

async function tx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    const result = await fn();
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

export const adjudicateClaim = (db: Db, claimId: string, asOf: string, by: By = { userId: null }): Promise<PipelineResult> =>
  tx(db, () => run(db, claimId, asOf, by));

/** FNOL (D51a): the claim is filed and decided at once, so a deniable claim is denied before any document is asked for. */
export const openClaim = (db: Db, c: { id: string; contractId: string; facts: Snapshot }, asOf: string, by: By = { userId: null }): Promise<PipelineResult> =>
  tx(db, async () => {
    await db.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)', [c.id, c.contractId, c.facts]);
    return run(db, c.id, asOf, by);
  });

/** Accepts a document version with the facts read from it, and decides the claim on what it now holds. */
export const acceptEvidence = (db: Db, r: { versionId: string; facts?: Record<string, unknown>; userId: string | null }, asOf: string): Promise<PipelineResult> =>
  tx(db, async () => run(db, (await reviewDocument(db, { ...r, result: 'accepted' })).claimId, asOf, r));

/** Stores an upload and, when the claim was closed for no response, reopens it. The bytes are written first, as in `uploadDocument`. */
export const uploadEvidence = (db: Db, store: DocumentStore, u: Upload): Promise<UploadedVersion> =>
  tx(db, async () => {
    const version = await uploadDocument(db, store, u);
    const { status } = (await db.query<{ status: ClaimStatus }>('SELECT "status" FROM "Claim" WHERE "id" = $1', [u.claimId])).rows[0]!;
    if (status === 'CLOSED_NO_RESPONSE') await transitionClaim(db, u.claimId, 'REOPENED', { userId: u.uploadedBy, reason: 'document.uploaded' });
    return version;
  });

/** Waives a document and decides the claim, both on the waiver's `asOf`. */
export const waiveEvidence = (db: Db, w: Waiver): Promise<PipelineResult> =>
  tx(db, async () => {
    await waiveDocument(db, w);
    return run(db, w.claimId, w.asOf, w);
  });

export type Override = { claimId: string; userId: string | null; reasonCode: string; reasonText: string; asOf: string };

/**
 * Signs off a referral: the claim's current engine decision, if it is a REFER with an amount, is approved at that
 * amount by a person. The override row repeats what the engine decided on (facts, documents, trace and both hashes)
 * and is dated `asOf`, under the ops version in force that day, whose tiers are the ones tested. Out of authority is
 * refused before anything is written. A referral with no amount (a rule gap) is never approved this way.
 * Seam (3.9): paid is 0 until payments are recorded; total incurred is then the larger of paid and this amount (D50).
 */
export const overrideDecision = (db: Db, o: Override): Promise<{ decisionId: string; outcome: string; claimStatus: ClaimStatus }> =>
  tx(db, async () => {
    const engine = (await db.query<{ id: string; outcome: string; payableCents: number | null; asOf: string; planVersionId: string; opsVersionId: string; reasons: string[] }>(
      `SELECT "id", "outcome", "payableCents", "asOf"::text AS "asOf", "planVersionId", "opsVersionId", "explanation"->'decision'->'reasons' AS "reasons"
       FROM "Decision" d WHERE "claimId" = $1 AND "overridesId" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "Decision" n WHERE n."supersedesId" = d."id" OR n."overridesId" = d."id")`, [o.claimId])).rows[0];
    if (!engine || engine.outcome !== 'REFER' || engine.payableCents === null || o.asOf < engine.asOf)
      throw new Error(`NOT_OVERRIDABLE: claim ${o.claimId} has no referral with an amount, dated on or before ${o.asOf}, that is still its decision`);

    const versions = await loadVersions(db);
    const [plan, decidedUnder] = [versions.get(engine.planVersionId)!, versions.get(engine.opsVersionId)!];
    const selected = selectVersions({ planVersion: plan.id }, [...versions.values()].filter((v) => v.product === plan.product).map((v) => ({ ...v, name: v.id })), o.asOf);
    if ('error' in selected) throw new Error(`${selected.error}: ${selected.kind} on ${o.asOf}`);
    const tier = await tierOf(db, o.userId);
    const power = powerToOverride([...plan.body.rules, ...decidedUnder.body.rules], engine.reasons);
    const check = checkAuthority(selected.ops.body.authority ?? [], tier, power, 0, engine.payableCents);
    if (!check.allowed) throw new OutOfAuthorityError(tier, check.lacks, `an override of decision ${engine.id}`);

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO "Decision" ("id", "claimId", "planVersionId", "planHash", "opsVersionId", "opsHash", "asOf", "facts", "documentVersions", "inputHash", "outputHash",
         "engineSemanticsVersion", "outcome", "payableCents", "explanation", "overridesId", "overrideReasonCode", "overrideReasonText", "overrideTier", "overrideTotalIncurredCents", "overrideBy")
       SELECT gen_random_uuid(), "claimId", "planVersionId", "planHash", $2, $3, $4::date, "facts", "documentVersions", "inputHash", "outputHash",
         "engineSemanticsVersion", 'APPROVE', "payableCents", "explanation", "id", $5, $6, $7, $8, $9::uuid
       FROM "Decision" WHERE "id" = $1 RETURNING "id"`,
      [engine.id, selected.ops.id, selected.ops.contentHash, o.asOf, o.reasonCode, o.reasonText, tier, check.totalIncurredCents, o.userId]);
    await transitionClaim(db, o.claimId, 'DECIDED', { userId: o.userId, reason: `override: ${o.reasonCode}` });
    return { decisionId: rows[0]!.id, outcome: 'APPROVE', claimStatus: 'DECIDED' };
  });

async function run(db: Db, claimId: string, asOf: string, { userId }: By): Promise<PipelineResult> {
  const by = { userId };
  const refer = async (error: 'CONTRACT_NOT_FOUND' | 'NO_EFFECTIVE_VERSION', detail: string) => {
    await transitionClaim(db, claimId, 'REFERRED', { ...by, reason: `${error}: ${detail}` });
    return { error, detail, decisionId: null, claimStatus: 'REFERRED' as const };
  };

  const claim = (await db.query<{ contractId: string; facts: Snapshot; status: ClaimStatus }>(
    'SELECT "contractId", "facts", "status" FROM "Claim" WHERE "id" = $1', [claimId])).rows[0];
  if (!claim) throw new Error(`Claim ${claimId} not found`);
  const contract = (await db.query<{ planVersionId: string; facts: Snapshot }>(
    'SELECT "planVersionId", "facts" FROM "Contract" WHERE "id" = $1', [claim.contractId])).rows[0];
  const versions = [...(await loadVersions(db)).values()];
  const product = versions.find((v) => v.id === contract?.planVersionId)?.product;
  const selected = contract && selectVersions({ planVersion: contract.planVersionId }, versions.filter((v) => v.product === product).map((v) => ({ ...v, name: v.id })), asOf);
  // Evidence (task 3.4, D55): a document's status and every entered fact are read from their rows and win over what
  // the claim was filed with. Without a contract there are no document types and nothing below is decided anyway.
  const docs = product ? Object.entries((await readDocumentStatuses(db, claimId)).docs).map(([type, status]) => [`docs.${type}`, status]) : [];
  const evidence = await readEvidence(db, claimId);
  // The snapshot is frozen here: the decision row stores exactly these facts, and replay reads them, never the claim.
  const snapshot = { ...contract?.facts, ...claim.facts, ...Object.fromEntries(docs), ...evidence.facts };
  const { documentVersions } = evidence;

  // Re-adjudication (D13, D40). The claim's current engine decision is the one no later engine row supersedes.
  const prev = (await db.query<{ id: string; inputHash: string; planVersionId: string; outcome: string }>(
    `SELECT "id", "inputHash", "planVersionId", "outcome" FROM "Decision" d WHERE "claimId" = $1 AND "overridesId" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Decision" n WHERE n."supersedesId" = d."id")`, [claimId])).rows[0];
  // PL-02: the same input is a no-op in any status. Nothing is written, not even a status move.
  if (prev && selected && !('error' in selected)
    && inputHashOf({ asOf, facts: snapshot, documentVersions, planHash: selected.plan.contentHash!, opsHash: selected.ops.contentHash! }) === prev.inputHash)
    return { decisionId: prev.id, outcome: prev.outcome, claimStatus: claim.status };

  // A changed input may only be decided from a status the table lets into IN_REVIEW; any other throws here.
  await transitionClaim(db, claimId, 'IN_REVIEW', by);

  // The one short-circuit (non-negotiable 7): without a contract there is no plan to pin and no rule to run.
  if (!selected) return refer('CONTRACT_NOT_FOUND', claim.contractId);
  if ('error' in selected) return refer(selected.error, `${selected.kind} on ${asOf}`);
  if (prev && prev.planVersionId !== selected.plan.id) throw new Error(`Claim ${claimId}: decision ${prev.id} is under a plan version its contract does not pin`);

  // PL-03: the new decision supersedes the current one, under the same plan and the ops version in force on this asOf.
  const decisionId = await recordDecision(db, { claimId, planVersionId: selected.plan.id, opsVersionId: selected.ops.id, snapshot, documentVersions, asOf, supersedesId: prev?.id });
  const { outcome } = (await db.query<{ outcome: string }>('SELECT "outcome" FROM "Decision" WHERE "id" = $1', [decisionId])).rows[0]!;
  const claimStatus = STATUS_FOR[outcome];
  if (!claimStatus) throw new Error(`No claim status for outcome ${outcome}`);
  await transitionClaim(db, claimId, claimStatus, by);
  return { decisionId, outcome, claimStatus };
}
