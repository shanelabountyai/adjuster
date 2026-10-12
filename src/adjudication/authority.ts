import type { Db } from '@/adjudication/decisions';

// Task 3.7 (D49, D58): who holds which authority tier. Rows are only ever inserted; the latest one for a user is in
// force. What a tier may do is ops rule data (`@/rules/authority`), so no tier is named here.

/** Gives a user a tier, or takes it away with `null`, with the audit event in the same statement. */
export async function assignTier(db: Db, a: { userId: string; tier: string | null; by: string | null }): Promise<void> {
  await db.query(
    `WITH made AS (
       INSERT INTO "TierAssignment" ("userId", "tier", "assignedBy") VALUES ($1::uuid, $2, $3::uuid) RETURNING "id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $3::uuid, 'authority.tier_assigned', 'User', $1, $4::jsonb FROM made`,
    [a.userId, a.tier, a.by, JSON.stringify({ tier: a.tier })]);
}

/** The tier a user holds now, or null: no user, never assigned, or taken away. */
export async function tierOf(db: Db, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ tier: string | null }>(
    `SELECT "tier" FROM "TierAssignment" WHERE "userId" = $1::uuid ORDER BY "id" DESC LIMIT 1`, [userId]);
  return rows[0]?.tier ?? null;
}
