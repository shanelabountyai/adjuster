import type { Db } from '@/adjudication/decisions';

// Task 3.9 (D50, D51j, D60): what a claim has been paid, and the seam the money leaves through. `payClaim` in the
// pipeline is the one writer of `Payment`.

export interface PaymentProvider {
  /** Sends `amountCents` to the claimant. A provider must never send twice for the same `idempotencyKey`. */
  pay(p: { idempotencyKey: string; claimId: string; amountCents: number }): Promise<{ ref: string }>;
}

/** Sends nothing. The reference is the key, so the same payment always reads the same. */
export const mockPaymentProvider: PaymentProvider = { pay: async ({ idempotencyKey }) => ({ ref: `mock-${idempotencyKey}` }) };

/** Everything paid on the claim, under any of its decisions. Paid money stays incurred (D50). */
export async function paidCents(db: Db, claimId: string): Promise<number> {
  const { rows } = await db.query<{ paid: number }>(
    `SELECT coalesce(sum(p."amountCents"), 0)::int AS "paid" FROM "Payment" p JOIN "Decision" d ON d."id" = p."decisionId" WHERE d."claimId" = $1`, [claimId]);
  return rows[0]!.paid;
}
