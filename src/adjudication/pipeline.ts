import { type ClaimStatus, transitionClaim } from '@/adjudication/claim-status';
import { type Db, loadVersions, recordDecision } from '@/adjudication/decisions';
import type { Snapshot } from '@/rules/derive';
import { selectVersions } from '@/rules/select';

// The pipeline (task 2.6, D39): claim → contract → versions → frozen snapshot → engine → decision and status move,
// all in one transaction. `db` must be one connection (a `pg` Client, never a Pool), or BEGIN and COMMIT would
// land on different sessions. No decision is written without a contract and both versions: the claim is referred.

const STATUS_FOR: Record<string, ClaimStatus> = { APPROVE: 'DECIDED', PARTIAL: 'DECIDED', DENY: 'DECIDED', PEND: 'PENDING_EVIDENCE', REFER: 'REFERRED' };

export type PipelineResult =
  | { decisionId: string; outcome: string; claimStatus: ClaimStatus }
  | { error: 'CONTRACT_NOT_FOUND' | 'NO_EFFECTIVE_VERSION'; detail: string; decisionId: null; claimStatus: 'REFERRED' };

export async function adjudicateClaim(db: Db, claimId: string, asOf: string, by: { userId: string | null } = { userId: null }): Promise<PipelineResult> {
  await db.query('BEGIN');
  try {
    const result = await run(db, claimId, asOf, by);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

async function run(db: Db, claimId: string, asOf: string, by: { userId: string | null }): Promise<PipelineResult> {
  const refer = async (error: 'CONTRACT_NOT_FOUND' | 'NO_EFFECTIVE_VERSION', detail: string) => {
    await transitionClaim(db, claimId, 'REFERRED', { ...by, reason: `${error}: ${detail}` });
    return { error, detail, decisionId: null, claimStatus: 'REFERRED' as const };
  };

  const claim = (await db.query<{ contractId: string; facts: Snapshot }>('SELECT "contractId", "facts" FROM "Claim" WHERE "id" = $1', [claimId])).rows[0];
  if (!claim) throw new Error(`Claim ${claimId} not found`);
  await transitionClaim(db, claimId, 'IN_REVIEW', by);

  // The one short-circuit (non-negotiable 7): without a contract there is no plan to pin and no rule to run.
  const contract = (await db.query<{ planVersionId: string; facts: Snapshot }>(
    'SELECT "planVersionId", "facts" FROM "Contract" WHERE "id" = $1', [claim.contractId])).rows[0];
  if (!contract) return refer('CONTRACT_NOT_FOUND', claim.contractId);

  const versions = [...(await loadVersions(db)).values()];
  const product = versions.find((v) => v.id === contract.planVersionId)?.product;
  const selected = selectVersions({ planVersion: contract.planVersionId }, versions.filter((v) => v.product === product).map((v) => ({ ...v, name: v.id })), asOf);
  if ('error' in selected) return refer(selected.error, `${selected.kind} on ${asOf}`);

  // The snapshot is frozen here: the decision row stores exactly these facts, and replay reads them, never the claim.
  const decisionId = await recordDecision(db, { claimId, planVersionId: selected.plan.id, opsVersionId: selected.ops.id, snapshot: { ...contract.facts, ...claim.facts }, asOf });
  const { outcome } = (await db.query<{ outcome: string }>('SELECT "outcome" FROM "Decision" WHERE "id" = $1', [decisionId])).rows[0]!;
  const claimStatus = STATUS_FOR[outcome];
  if (!claimStatus) throw new Error(`No claim status for outcome ${outcome}`);
  await transitionClaim(db, claimId, claimStatus, by);
  return { decisionId, outcome, claimStatus };
}
