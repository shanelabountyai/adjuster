import { type ClaimStatus, transitionClaim } from '@/adjudication/claim-status';
import { type Db, inputHashOf, loadVersions, recordDecision } from '@/adjudication/decisions';
import { readDocumentStatuses, readEvidence, reviewDocument, waiveDocument, type Waiver } from '@/adjudication/documents';
import type { Snapshot } from '@/rules/derive';
import { selectVersions } from '@/rules/select';

// The pipeline (task 2.6, D39): claim → contract → versions → frozen snapshot → engine → decision and status move,
// all in one transaction. `db` must be one connection (a `pg` Client, never a Pool), or BEGIN and COMMIT would
// land on different sessions. No decision is written without a contract and both versions: the claim is referred.
// Running a claim again (task 2.7, D40) returns its current decision when the input is unchanged, and supersedes it otherwise.
// Filing a claim, accepting a document and waiving one each decide the claim in the transaction that makes the change
// (task 3.5, D51a, D51d, D56), so a change the status table will not let be decided is not made at all.

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

/** Waives a document and decides the claim, both on the waiver's `asOf`. */
export const waiveEvidence = (db: Db, w: Waiver): Promise<PipelineResult> =>
  tx(db, async () => {
    await waiveDocument(db, w);
    return run(db, w.claimId, w.asOf, w);
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
