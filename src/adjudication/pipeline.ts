import { tierOf } from '@/adjudication/authority';
import { type ClaimStatus, IllegalTransitionError, transitionClaim } from '@/adjudication/claim-status';
import { type Db, inputHashOf, loadVersions, recordDecision } from '@/adjudication/decisions';
import { type DocumentStore, OutOfAuthorityError, readDocumentStatuses, readEvidence, reviewDocument, type Upload, uploadDocument, type UploadedVersion, waiveDocument, type Waiver } from '@/adjudication/documents';
import { paidCents, type PaymentProvider } from '@/adjudication/payments';
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
// Paying sends the part of the current decision's amount the claim has not been paid, and closes it (task 3.9, D51j, D60).
// A supplemental is an explicit reopen of a closed claim by staff; the new facts then decide it as any others do (task 3.10, D61).

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
 * Total incurred is the larger of what the claim has been paid and this amount (D50).
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
    const check = checkAuthority(selected.ops.body.authority ?? [], tier, power, await paidCents(db, o.claimId), engine.payableCents);
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

export type Pay = { claimId: string; asOf: string; userId: string | null };

/**
 * Pays a decided claim. The current decision's amount is the claim's total, so what goes out is the part not yet
 * paid and the deductible is taken once (D51j). Nothing due is a no-op that writes nothing: a denial, an approval
 * at 0, a claim already paid, a recomputed total below what was paid. A claim the status table will not let be paid
 * (a referral nobody signed off) throws. The payment row, its audit event and the moves to CLOSED are one transaction.
 */
export const payClaim = (db: Db, provider: PaymentProvider, p: Pay): Promise<{ paymentCents: number; claimStatus: ClaimStatus }> =>
  tx(db, async () => {
    // The row lock makes two payers take turns; the second then finds nothing due.
    const claim = (await db.query<{ status: ClaimStatus }>('SELECT "status" FROM "Claim" WHERE "id" = $1 FOR UPDATE', [p.claimId])).rows[0];
    if (!claim) throw new Error(`Claim ${p.claimId} not found`);
    const d = (await db.query<{ id: string; payableCents: number | null; asOf: string }>(
      `SELECT "id", "payableCents", "asOf"::text AS "asOf" FROM "Decision" d WHERE "claimId" = $1
         AND NOT EXISTS (SELECT 1 FROM "Decision" n WHERE n."supersedesId" IN (d."id", d."overridesId") OR n."overridesId" = d."id")`, [p.claimId])).rows[0];
    const due = d && d.payableCents !== null ? d.payableCents - await paidCents(db, p.claimId) : 0;
    if (!d || due <= 0) return { paymentCents: 0, claimStatus: claim.status };
    if (p.asOf < d.asOf) throw new Error(`Claim ${p.claimId}: a payment on ${p.asOf} is before its decision of ${d.asOf}`);

    const by = { userId: p.userId };
    const mark = (paymentStatus: string) => db.query('UPDATE "Claim" SET "paymentStatus" = $2 WHERE "id" = $1', [p.claimId, paymentStatus]);
    await transitionClaim(db, p.claimId, 'PAYMENT_PENDING', by);
    await mark('PENDING');
    // ponytail: the provider is called inside the transaction, so PENDING is never seen and a crash after a real
    // provider paid leaves no row. A real one needs PENDING committed first and a retry on the same key (the decision id).
    const { ref } = await provider.pay({ idempotencyKey: d.id, claimId: p.claimId, amountCents: due });
    await db.query(
      `WITH made AS (
         INSERT INTO "Payment" ("id", "decisionId", "amountCents", "providerRef", "asOf", "paidBy")
         VALUES (gen_random_uuid(), $1, $2, $3, $4::date, $5::uuid) RETURNING "id")
       INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
       SELECT $5::uuid, 'claim.paid', 'Claim', $6, $7::jsonb FROM made`,
      [d.id, due, ref, p.asOf, p.userId, p.claimId, JSON.stringify({ decisionId: d.id, amountCents: due, providerRef: ref, asOf: p.asOf })]);
    await transitionClaim(db, p.claimId, 'PAID', by);
    await mark('PAID');
    await transitionClaim(db, p.claimId, 'CLOSED', by);
    return { paymentCents: due, claimStatus: 'CLOSED' };
  });

export type Reopen = { claimId: string; userId: string | null; reason: string };

/**
 * Reopens a closed claim for a supplemental. Only a user who holds a tier may, and only with a reason, which goes on
 * the status-change audit event. Nothing is approved here, so no amount is tested: the override or waiver that
 * approves the new total is tested on total incurred. A claim closed for no response reopens by its upload instead.
 */
export const reopenClaim = (db: Db, r: Reopen): Promise<{ claimStatus: ClaimStatus }> =>
  tx(db, async () => {
    if (!r.reason.trim()) throw new Error(`REASON_REQUIRED: reopening claim ${r.claimId} needs a reason`);
    const tier = await tierOf(db, r.userId);
    if (!tier) throw new OutOfAuthorityError(tier, ['tier'], `reopening claim ${r.claimId}`);
    const claim = (await db.query<{ status: ClaimStatus }>('SELECT "status" FROM "Claim" WHERE "id" = $1 FOR UPDATE', [r.claimId])).rows[0];
    if (!claim) throw new Error(`Claim ${r.claimId} not found`);
    if (claim.status !== 'CLOSED') throw new IllegalTransitionError(claim.status, 'REOPENED', 'only a closed claim is reopened for a supplemental');
    await transitionClaim(db, r.claimId, 'REOPENED', { userId: r.userId, reason: r.reason });
    return { claimStatus: 'REOPENED' };
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
