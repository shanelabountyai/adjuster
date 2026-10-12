import { transitionClaim } from '@/adjudication/claim-status';
import { type Db, loadVersions } from '@/adjudication/decisions';
import { selectVersions } from '@/rules/select';

// No response (task 3.6, domain brief §6, D51h, D57). The job runs on an injected date and reads the days from the ops
// rule set in force that day. Days count from the `asOf` of the claim's current engine decision, which is a PEND for
// every claim it touches, so a new PEND starts the count again. A reminder is an inserted row; closing moves the
// claim's status and writes no decision, so the claim's decision is still the PEND and never a denial.

// The claim's current engine decision is the one no later engine row supersedes (as in pipeline.ts).
const CURRENT = `d."overridesId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Decision" n WHERE n."supersedesId" = d."id")`;

/** The highest reminder sent for the claim's current engine decision; 0 when none was. */
export const readReminderLevel = async (db: Db, claimId: string): Promise<number> => (await db.query<{ level: number }>(
  `SELECT coalesce(max(r."level"), 0)::int AS "level" FROM "Decision" d JOIN "ClaimReminder" r ON r."decisionId" = d."id"
   WHERE d."claimId" = $1 AND ${CURRENT}`, [claimId])).rows[0]!.level;

export type NoResponseRun = { reminded: { claimId: string; level: number }[]; closed: string[]; skipped: string[] };

/**
 * One run of the job. A claim gets at most one reminder a run, at the level its days have reached, so a run that
 * comes late sends the second reminder alone. `skipped` names pending claims with no ops version or no reminder days
 * on `asOf`: without the days nothing is sent and nothing is closed.
 * Seam: nothing is delivered. The row and its audit event are the reminder; a mailer would read them.
 */
export async function runNoResponse(db: Db, asOf: string): Promise<NoResponseRun> {
  const versions = [...(await loadVersions(db)).values()].map((v) => ({ ...v, name: v.id }));
  const { rows } = await db.query<{ claimId: string; decisionId: string; planVersionId: string; days: number }>(
    `SELECT c."id" AS "claimId", d."id" AS "decisionId", k."planVersionId", ($1::date - d."asOf")::int AS "days"
     FROM "Claim" c JOIN "Contract" k ON k."id" = c."contractId" JOIN "Decision" d ON d."claimId" = c."id" AND ${CURRENT}
     WHERE c."status" = 'PENDING_EVIDENCE' AND d."outcome" = 'PEND' ORDER BY c."id"`, [asOf]);
  const run: NoResponseRun = { reminded: [], closed: [], skipped: [] };
  for (const { claimId, decisionId, planVersionId, days } of rows) {
    const product = versions.find((v) => v.id === planVersionId)?.product;
    const selected = selectVersions({ planVersion: planVersionId }, versions.filter((v) => v.product === product), asOf);
    const r = 'error' in selected ? undefined : selected.ops.body.reminders;
    if (!r) {
      run.skipped.push(claimId);
    } else if (days >= r.closeDay) {
      await transitionClaim(db, claimId, 'CLOSED_NO_RESPONSE', { userId: null, reason: `no response ${days} days after the request` });
      run.closed.push(claimId);
    } else {
      const due = Number(days >= r.firstDay) + Number(days >= r.secondDay);
      if (!due) continue;
      // The row and its audit event in one statement. A level already sent for this decision, by an earlier run or
      // one racing this one, is the unique (decision, level): nothing is inserted and nothing is reported.
      const sent = await db.query(
        `WITH made AS (
           INSERT INTO "ClaimReminder" ("id", "decisionId", "level", "asOf") VALUES (gen_random_uuid(), $1, $2, $3::date)
           ON CONFLICT ("decisionId", "level") DO NOTHING RETURNING "id")
         INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
         SELECT NULL, 'claim.reminder_sent', 'Claim', $4, $5::jsonb FROM made RETURNING "id"`,
        [decisionId, due, asOf, claimId, JSON.stringify({ decisionId, level: due, asOf, days })]);
      if (sent.rows.length) run.reminded.push({ claimId, level: due });
    }
  }
  return run;
}
