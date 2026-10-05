import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { publishRuleSet, verifyDecisions, type Db } from '@/adjudication/decisions';
import { adjudicateClaim } from '@/adjudication/pipeline';

// Task 2.6. Golden claims go in as a contract and a claim and come out as a decision row plus a status move; the
// pipeline, not the test, picks the versions. PL-06 and the no-version case refer the claim and write no decision.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

const versionIds: Record<string, string> = {};
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
});

const onContract = ([k]: [string, unknown]) => k.startsWith('contract.') || k.startsWith('product.');
async function file(id: string, plan: string, facts: Record<string, unknown>) {
  const all = Object.entries(facts);
  await client.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${id}`, versionIds[plan], Object.fromEntries(all.filter(onContract))]);
  await client.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)', [id, `CT-${id}`, Object.fromEntries(all.filter((e) => !onContract(e)))]);
}
const statusOf = async (id: string) => (await client.query('SELECT "status" FROM "Claim" WHERE "id" = $1', [id])).rows[0].status;
const moves = async (id: string) => (await client.query(
  `SELECT "data"->>'to' AS "to" FROM "AuditEvent" WHERE "action" = 'claim.status_changed' AND "targetId" = $1 ORDER BY "id"`, [id])).rows.map((r) => r.to);
const decisionCount = async (id: string) => Number((await client.query('SELECT count(*) FROM "Decision" WHERE "claimId" = $1', [id])).rows[0].count);
const STATUS = { APPROVE: 'DECIDED', PARTIAL: 'DECIDED', DENY: 'DECIDED', PEND: 'PENDING_EVIDENCE', REFER: 'REFERRED' } as Record<string, string>;
const GOLDEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map((n) => read(`fixtures/gc/GC-${String(n).padStart(2, '0')}.json`));

describe('adjudicateClaim', () => {
  it('GC-01..10 and GC-12..14 through the pipeline: fixture outcome, the versions the fixture names, the mapped status, and verify OK', async () => {
    for (const fx of GOLDEN) {
      const id = `P-${fx.id}`; // the audit log is append-only, so ids are this file's own
      await file(id, fx.plan, fx.facts);
      const before = (await moves(id)).length;
      const r = await adjudicateClaim(client, id, fx.asOf);
      const d = (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [r.decisionId])).rows[0];
      expect([fx.id, d.outcome, d.payableCents, d.explanation.decision.reasons]).toEqual([fx.id, fx.expected.outcome, fx.expected.payableCents, fx.expected.reasons]);
      expect([d.planVersionId, d.opsVersionId]).toEqual([versionIds[fx.plan], versionIds[fx.ops]]);
      expect(d.facts).toEqual(fx.facts);
      expect(r.claimStatus).toBe(STATUS[fx.expected.outcome]);
      expect(await statusOf(id)).toBe(r.claimStatus);
      expect((await moves(id)).slice(before)).toEqual(['IN_REVIEW', r.claimStatus]);
    }
    expect(await verifyDecisions(client)).toEqual({ checked: GOLDEN.length, failures: [] });
  });

  it('PL-06 contract not found: no decision row, the claim is referred', async () => {
    const fx = read('fixtures/pl/PL-06.json');
    await file('0001', 'plan-v1', GOLDEN[0].facts); // the fixture's one existing contract, CT-0001
    await client.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)', ['P-PL-06', fx.claim.contractId, fx.claim.facts]);
    const r = await adjudicateClaim(client, 'P-PL-06', '2025-09-18');
    expect(r).toMatchObject({ error: fx.expected.error, decisionId: fx.expected.decision, claimStatus: fx.expected.claimStatus });
    expect(await statusOf('P-PL-06')).toBe(fx.expected.claimStatus);
    expect(await decisionCount('P-PL-06')).toBe(0);
  });

  it('no effective version on asOf: no decision row, the claim is referred', async () => {
    await file('P-EARLY', 'plan-v1', GOLDEN[0].facts);
    expect(await adjudicateClaim(client, 'P-EARLY', '2024-12-31')).toMatchObject({ error: 'NO_EFFECTIVE_VERSION', decisionId: null, claimStatus: 'REFERRED' });
    expect(await decisionCount('P-EARLY')).toBe(0);
  });

  it('a failure after the decision insert rolls everything back: no decision, no move, no audit event', async () => {
    await file('P-ROLLBACK', 'plan-v1', GOLDEN[0].facts);
    const before = (await moves('P-ROLLBACK')).length;
    let auditWrites = 0;
    const failing: Db = { query: (sql, params) => {
      if (sql.includes('INSERT INTO "AuditEvent"') && ++auditWrites === 2) throw new Error('planted');
      return client.query(sql, params) as never;
    } };
    await expect(adjudicateClaim(failing, 'P-ROLLBACK', GOLDEN[0].asOf)).rejects.toThrow('planted');
    expect(await statusOf('P-ROLLBACK')).toBe('OPEN');
    expect(await decisionCount('P-ROLLBACK')).toBe(0);
    expect((await moves('P-ROLLBACK')).length).toBe(before);
  });

  // Task 2.7 (D40). Nothing edits a claim's facts in this phase, so `change` is written to the row directly.
  const enter = (id: string, change: object) => client.query('UPDATE "Claim" SET "facts" = "facts" || $2::jsonb WHERE "id" = $1', [id, JSON.stringify(change)]);
  async function rerun(fxId: string) {
    const fx = read(`fixtures/pl/${fxId}.json`);
    const id = `P-${fx.id}`;
    await file(id, fx.plan, fx.facts);
    const ids: string[] = [];
    for (const [i, run] of fx.runs.entries()) {
      const e = run.expected;
      await enter(id, run.change);
      expect([i, await statusOf(id)]).toEqual([i, run.statusBefore]);
      const before = (await moves(id)).length;
      const r = await adjudicateClaim(client, id, run.asOf);
      ids.push(r.decisionId!);
      const d = (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [r.decisionId])).rows[0];
      expect([i, r.decisionId, d.supersedesId]).toEqual([i, ids[e.decision], e.supersedes === null ? null : ids[e.supersedes]]);
      expect([d.outcome, d.payableCents, d.explanation.decision.reasons]).toEqual([e.outcome, e.payableCents, e.reasons]);
      expect([r.claimStatus, await statusOf(id), await decisionCount(id)]).toEqual([e.claimStatus, e.claimStatus, e.decisionRows]);
      expect((await moves(id)).slice(before)).toEqual(e.decision === i ? ['IN_REVIEW', e.claimStatus] : []);
      if (e.decision === i) expect([d.planVersionId, d.opsVersionId]).toEqual([versionIds[fx.plan], versionIds[run.ops]]);
    }
    expect((await verifyDecisions(client)).failures).toEqual([]);
    return { id, fx, ids };
  }

  it('PL-02 an unchanged inputHash is a no-op: the same decision comes back; no row, no move, no audit event', () => rerun('PL-02'));

  it('PL-03 changed facts supersede under the same plan and the ops version in force on the new asOf', () => rerun('PL-03'));

  it('changed facts on a decided claim throw and write nothing: it must be appealed or reopened first', async () => {
    const { id, fx } = await rerun('PL-03');
    await enter(id, { 'claim.coveredRepairCents': 31000 });
    await expect(adjudicateClaim(client, id, fx.runs.at(-1).asOf)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect([await statusOf(id), await decisionCount(id)]).toEqual(['DECIDED', 2]);
  });

  it('the same facts on a later asOf are a changed input', async () => {
    const fx = read('fixtures/pl/PL-03.json');
    await file('P-LATER', fx.plan, fx.facts);
    const first = await adjudicateClaim(client, 'P-LATER', '2026-03-25');
    const second = await adjudicateClaim(client, 'P-LATER', '2026-04-02');
    const d = (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [second.decisionId])).rows[0];
    expect([d.supersedesId, d.outcome, d.opsVersionId]).toEqual([first.decisionId, 'PEND', versionIds['ops-v2']]);
    expect((await verifyDecisions(client)).failures).toEqual([]);
  });

  it('publishing a version writes no decision row, and a claim is not re-run by it', async () => {
    const { id, fx, ids } = await rerun('PL-03');
    const count = async () => Number((await client.query('SELECT count(*) FROM "Decision"')).rows[0].count);
    const before = await count();
    await publishRuleSet(client, { ...read('rules/electronics/ops-v2.json'), version: 3, effectiveFrom: '2026-06-01' });
    expect(await count()).toBe(before);
    expect((await adjudicateClaim(client, id, fx.runs.at(-1).asOf)).decisionId).toBe(ids.at(-1));
    expect(await count()).toBe(before);
    expect((await verifyDecisions(client)).failures).toEqual([]);
  });
});
