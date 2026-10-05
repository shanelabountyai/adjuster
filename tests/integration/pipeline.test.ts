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

  it('a claim that cannot be reviewed (already decided) throws and writes nothing', async () => {
    await file('P-TWICE', 'plan-v1', GOLDEN[0].facts);
    await adjudicateClaim(client, 'P-TWICE', GOLDEN[0].asOf);
    await expect(adjudicateClaim(client, 'P-TWICE', GOLDEN[0].asOf)).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect(await decisionCount('P-TWICE')).toBe(1);
  });
});
