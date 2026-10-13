import { renderLetter, renderNote, type DecisionRecord } from '@/rules/render';
import { traceSchema } from '@/rules/schema';
import type { Trace } from '@/rules/adjudicate';
import type { Db } from './decisions';

// Task 3.11 (D62). What a letter or note says beyond the trace is read here from stored rows: the decision's own
// columns, the document versions it names, and the waivers its fact snapshot shows it relied on. Nothing here reads a
// rule set, a current status or a clock, and every row read is insert-only.

type Row = {
  claimId: string; explanation: unknown; engineSemanticsVersion: string; documentVersions: string[]; facts: Record<string, unknown>;
  asOf: string; payableCents: number | null; opsHash: string; overridesId: string | null; overrideBy: string | null; overrideTier: string | null;
  overrideTotalIncurredCents: number | null; overrideReasonCode: string | null; overrideReasonText: string | null;
};

export async function readDecisionRecord(db: Db, decisionId: string): Promise<{ trace: Trace; record: DecisionRecord }> {
  const d = (await db.query<Row>('SELECT *, "asOf"::text AS "asOf" FROM "Decision" WHERE "id" = $1', [decisionId])).rows[0];
  if (!d) throw new Error(`no decision ${decisionId}`);
  const documents = (await db.query<DecisionRecord['documents'][number]>(
    `SELECT d."type", v."version", v."id" AS "versionId", v."sha256" FROM "DocumentVersion" v JOIN "Document" d ON d."id" = v."documentId"
     WHERE v."id"::text = ANY($1) ORDER BY d."type"`, [d.documentVersions])).rows;
  // A waiver is one insert-only row per claim and type (D54), so a snapshot that says `waived` relied on that row.
  const waivers = (await db.query<DecisionRecord['waivers'][number]>(
    `SELECT "type", "tier", "asOf"::text AS "asOf", "waivedBy" AS "by", "reasonText" FROM "DocumentWaiver"
     WHERE "claimId" = $1 AND $2::jsonb ->> ('docs.' || "type") = 'waived' ORDER BY "type"`, [d.claimId, JSON.stringify(d.facts)])).rows;
  return {
    trace: traceSchema.parse(d.explanation),
    record: {
      decisionId, engine: d.engineSemanticsVersion, documents, waivers,
      override: d.overridesId === null ? null : {
        overridesId: d.overridesId, asOf: d.asOf, payableCents: d.payableCents!, by: d.overrideBy, tier: d.overrideTier!,
        totalIncurredCents: d.overrideTotalIncurredCents!, opsHash: d.opsHash, reasonCode: d.overrideReasonCode!, reasonText: d.overrideReasonText!,
      },
    },
  };
}

/** The letter and the note of one stored decision. */
export async function renderDecision(db: Db, decisionId: string): Promise<{ letter: string; note: string }> {
  const { trace, record } = await readDecisionRecord(db, decisionId);
  return { letter: renderLetter(trace, record), note: renderNote(trace, record) };
}
