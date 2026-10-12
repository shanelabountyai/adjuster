import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { publishRuleSet, verifyDecisions, type Db } from '@/adjudication/decisions';
import { enterFact, LocalDiskDocumentStore } from '@/adjudication/documents';
import { adjudicateClaim } from '@/adjudication/pipeline';
import { acceptDocument, fileClaim } from '../../scripts/seed-decisions';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderLetter, renderNote } from '@/rules/render';
import { traceSchema } from '@/rules/schema';

// Task 2.6. Golden claims go in as a contract and a claim and come out as a decision row plus a status move; the
// pipeline, not the test, picks the versions. PL-06 and the no-version case refer the claim and write no decision.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

const versionIds: Record<string, string> = {};
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
});

// Task 3.4: documents are filed through the services. The store is content-addressed, so one directory serves every run.
const store = new LocalDiskDocumentStore(join(tmpdir(), 'adjuster-pipeline-docs'));
const STAFF = '00000000-0000-4000-8000-000000000001';
const file = (id: string, plan: string, facts: Record<string, unknown>) => fileClaim(client, store, versionIds[plan], { id, facts });
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
      // the snapshot is rebuilt from rows: the fixture's facts, plus `requested` for each document type it does not mention (D51b)
      expect(d.facts).toMatchObject(fx.facts);
      expect(Object.entries(d.facts).filter(([k]) => !(k in fx.facts)).every(([k, v]) => k.startsWith('docs.') && v === 'requested')).toBe(true);
      expect(r.claimStatus).toBe(STATUS[fx.expected.outcome]);
      expect(await statusOf(id)).toBe(r.claimStatus);
      expect((await moves(id)).slice(before)).toEqual(['IN_REVIEW', r.claimStatus]);
    }
    expect(await verifyDecisions(client)).toEqual({ checked: GOLDEN.length, failures: [] });

    // Task 2.10 (D43): the Python oracle gets each stored explanation and nothing else, and reproduces every amount.
    const recompute = (rows: { id: string; explanation: unknown }[]) =>
      spawnSync('python3', ['tools/recompute_from_trace.py'], { input: rows.map((r) => JSON.stringify(r)).join('\n'), encoding: 'utf8' });
    const stored = (await client.query('SELECT "claimId" AS "id", "explanation" FROM "Decision"')).rows;
    const out = recompute(stored);
    expect([out.status, out.stderr]).toEqual([0, '']);
    expect(JSON.parse(out.stdout)).toEqual(Object.fromEntries(GOLDEN.map((fx) => [`P-${fx.id}`, fx.expected.payableCents])));
    // not vacuous: a deductible edited in the stored steps, an amount edited in the decision, and no input at all each fail
    const gc01 = structuredClone(stored.find((r) => r.id === 'P-GC-01'));
    gc01.explanation.valuation.steps.find((s: { id: string }) => s.id === 'c5').operand.value += 1;
    const gc02 = structuredClone(stored.find((r) => r.id === 'P-GC-02'));
    gc02.explanation.decision.payableCents = 0; // a denial pays null, never 0
    for (const bad of [[gc01], [gc02], []]) expect(recompute(bad).status).toBe(1);
  });

  it('PL-05: a stored decision renders the same letter and note after a version with different templates is published', async () => {
    const stored = async (id: string) => traceSchema.parse((await client.query('SELECT "explanation" FROM "Decision" WHERE "id" = $1', [id])).rows[0].explanation);
    const render = async (id: string) => { const t = await stored(id); return [renderLetter(t), renderNote(t)]; };
    const ids: string[] = [];
    for (const fx of [GOLDEN[0], GOLDEN[3]]) { // GC-01 (amount lines) and GC-04 (two reasons)
      await file(`P5-${fx.id}`, fx.plan, fx.facts);
      ids.push((await adjudicateClaim(client, `P5-${fx.id}`, fx.asOf)).decisionId!);
    }
    const before = await Promise.all(ids.map(render));

    // plan-v3: every reason text and every step label reworded, effective before both claims
    const v1 = read('rules/electronics/plan-v1.json');
    const v3 = { ...v1, version: 3,
      rules: v1.rules.map((r: { rows: { then: Record<string, unknown> }[] }) => ({ ...r, rows: r.rows.map((x) => ({ ...x,
        then: { ...x.then, ...(x.then.claimantText ? { claimantText: 'REWORDED' } : {}), ...(x.then.noteText ? { noteText: 'REWORDED' } : {}) } })) })),
      payout: { ...v1.payout, steps: v1.payout.steps.map((s: { label?: string }) => (s.label ? { ...s, label: 'REWORDED' } : s)) } };
    const v3Id = await publishRuleSet(client, v3);

    expect(await Promise.all(ids.map(render))).toEqual(before);
    expect(before.flat().join('')).not.toContain('REWORDED');
    // the same two claims under v3 do carry the new wording, so the check above is not vacuous
    for (const fx of [GOLDEN[0], GOLDEN[3]]) {
      const id = `P5v3-${fx.id}`;
      await fileClaim(client, store, v3Id, { id, facts: fx.facts });
      expect(renderLetter(await stored((await adjudicateClaim(client, id, fx.asOf)).decisionId!))).toContain('REWORDED');
    }
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

  // Task 2.8. plan-v2 is published only after decisions exist, so this test publishes for itself.
  it('RV-01 each contract keeps the plan it pinned: publishing plan-v2 changes no stored decision, and verify stays OK', async () => {
    await client.query('TRUNCATE "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
    for (const name of ['plan-v1', 'ops-v1', 'ops-v2']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
    const [soldBefore, soldAfter] = read('fixtures/rv/RV-01.json').cases;
    const decide = async (id: string, c: { plan: string; facts: Record<string, unknown>; asOf: string }) => {
      await file(id, c.plan, c.facts);
      const r = await adjudicateClaim(client, id, c.asOf);
      return (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [r.decisionId])).rows[0];
    };
    const stored = async () => (await client.query('SELECT * FROM "Decision" ORDER BY "id"')).rows;

    await decide('P-RV-GC-01', GOLDEN[0]);
    const d1 = await decide('P-RV-01-v1', soldBefore);
    const existing = await stored();
    versionIds['plan-v2'] = await publishRuleSet(client, read('rules/electronics/plan-v2.json'));
    const d2 = await decide('P-RV-01-v2', soldAfter);

    expect([d1, d2].map((d) => [d.outcome, d.payableCents, d.planVersionId, d.opsVersionId])).toEqual(
      [soldBefore, soldAfter].map((c) => [c.expected.outcome, c.expected.payableCents, versionIds[c.plan], versionIds[c.ops]]));
    expect((await stored()).filter((d) => d.id !== d2.id)).toEqual(existing);
    expect((await adjudicateClaim(client, 'P-RV-01-v1', soldBefore.asOf)).decisionId).toBe(d1.id); // still a no-op under its own plan
    expect(await verifyDecisions(client)).toEqual({ checked: 3, failures: [] });
  });

  // Task 2.7 (D40), 3.4 (D55). A claim's inputs change by rows: a document accepted, or a fact entered by a person.
  const enter = async (id: string, change: Record<string, unknown>) => {
    for (const [k, value] of Object.entries(change))
      if (k.startsWith('docs.')) await acceptDocument(client, store, id, k.slice(5));
      else await enterFact(client, { claimId: id, factId: k, value, userId: STAFF });
  };
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
