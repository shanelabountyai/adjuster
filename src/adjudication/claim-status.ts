import type { Db } from '@/adjudication/decisions';

// Claim status (domain brief §7, D38). It is not the decision outcome and not the payment status; the legal moves are
// this table and nothing else. `transitionClaim` is the one writer of `Claim.status`.

export const CLAIM_STATUSES = ['OPEN', 'PENDING_EVIDENCE', 'IN_REVIEW', 'REFERRED', 'DECIDED', 'PAYMENT_PENDING', 'PAID', 'CLOSED',
  'CLOSED_NO_RESPONSE', 'WITHDRAWN', 'UNDER_APPEAL', 'REOPENED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type CurrentDecision = { outcome: string; payableCents: number | null };

// What the claim's current decision must be for a move out of DECIDED. No decision fails every guard (unknown is not a pass).
const GUARDS = {
  denied: (d: CurrentDecision) => d.outcome === 'DENY',
  denied_or_zero: (d: CurrentDecision) => d.outcome === 'DENY' || d.payableCents === 0,
  payable: (d: CurrentDecision) => d.payableCents !== null && d.payableCents > 0,
};

const TRANSITIONS: Record<ClaimStatus, Partial<Record<ClaimStatus, true | keyof typeof GUARDS>>> = {
  OPEN: { PENDING_EVIDENCE: true, IN_REVIEW: true, WITHDRAWN: true },
  PENDING_EVIDENCE: { IN_REVIEW: true, CLOSED_NO_RESPONSE: true, WITHDRAWN: true },
  IN_REVIEW: { PENDING_EVIDENCE: true, REFERRED: true, DECIDED: true, WITHDRAWN: true },
  REFERRED: { DECIDED: true, PENDING_EVIDENCE: true, WITHDRAWN: true },
  DECIDED: { PAYMENT_PENDING: 'payable', UNDER_APPEAL: 'denied', CLOSED: 'denied_or_zero' },
  UNDER_APPEAL: { DECIDED: true },
  PAYMENT_PENDING: { PAID: true },
  PAID: { CLOSED: true },
  CLOSED: { REOPENED: true },
  CLOSED_NO_RESPONSE: { REOPENED: true },
  REOPENED: { IN_REVIEW: true },
  WITHDRAWN: {},
};

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(readonly from: string, readonly to: string, why: string) {
    super(`Illegal claim transition ${from} → ${to}: ${why}`);
  }
}

/** Throws unless `from → to` is in the table and its guard, if it has one, holds for the claim's current decision. */
export function assertTransition(from: ClaimStatus, to: ClaimStatus, decision?: CurrentDecision | null): void {
  const rule = TRANSITIONS[from]?.[to];
  if (!rule) throw new IllegalTransitionError(from, to, 'not in the table');
  if (rule !== true && !(decision && GUARDS[rule](decision))) throw new IllegalTransitionError(from, to, `needs a current decision that is ${rule}`);
}

/**
 * Moves a claim and appends the audit event in one statement, so neither exists without the other. The update is
 * conditional on the status that was checked: a claim someone else moved in between throws instead of moving twice.
 */
export async function transitionClaim(db: Db, claimId: string, to: ClaimStatus, by: { userId: string | null; reason?: string }): Promise<void> {
  // The current decision is the one no later row supersedes or overrides. An override goes with the decision it
  // overrides: once that is superseded, the override is history too (D59).
  const { rows } = await db.query<{ status: ClaimStatus; decisionId: string | null; outcome: string; payableCents: number | null }>(
    `SELECT c."status", d."id" AS "decisionId", d."outcome", d."payableCents" FROM "Claim" c
     LEFT JOIN "Decision" d ON d."claimId" = c."id"
       AND NOT EXISTS (SELECT 1 FROM "Decision" n WHERE n."supersedesId" IN (d."id", d."overridesId") OR n."overridesId" = d."id")
     WHERE c."id" = $1`, [claimId]);
  if (!rows.length) throw new Error(`Claim ${claimId} not found`);
  if (rows.length > 1) throw new Error(`Claim ${claimId} has ${rows.length} current decisions`);
  const { status: from, decisionId, outcome, payableCents } = rows[0]!;
  assertTransition(from, to, decisionId ? { outcome, payableCents } : null);
  const moved = await db.query(
    `WITH moved AS (UPDATE "Claim" SET "status" = $3, "updatedAt" = now() WHERE "id" = $1 AND "status" = $2 RETURNING "id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $4::uuid, 'claim.status_changed', 'Claim', "id", $5::jsonb FROM moved RETURNING "id"`,
    [claimId, from, to, by.userId, JSON.stringify({ from, to, decisionId, reason: by.reason ?? null })]);
  if (!moved.rows.length) throw new Error(`Claim ${claimId} left ${from} before it could move to ${to}`);
}
