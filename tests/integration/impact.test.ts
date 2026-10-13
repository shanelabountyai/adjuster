import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDraft, impactOfDraft, publishDraft, saveDraft } from '@/adjudication/drafts';
import { sha256Hex } from '@/rules/canonical';
import { seedDecisions } from '../../scripts/seed-decisions';
import { applyEdits } from '../helpers/edits';
import { staffAt } from '../helpers/tiers';

// Task 4.4 (D71, D78). The service reads the cases from stored rows: every ID fixture is saved as a draft over the
// seed and its expected deltas are read back for the 13 golden claims it names. The seed holds other claims too (the
// RV-01 pair, GC-01 on two more days, GC-11 and GC-15), which a fixture does not speak for.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const asOf: string = read('rules/electronics/ops-v3.json').effectiveFrom; // the first day `author_rules` is in force
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

let staff: { senior: string; manager: string };
beforeAll(async () => {
  await client.connect();
  await seedDecisions(client);
  staff = await staffAt(client, ['senior', 'manager']);
});
const count = async (table: string) => Number((await client.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
const dropDraft = () => client.query(`DELETE FROM "RuleSetVersion" WHERE "status" = 'draft'`);

describe('the impact diff of a stored draft', () => {
  for (const n of [1, 2, 3, 4]) {
    const fx = read(`fixtures/id/ID-0${n}.json`);
    it(`${fx.id} ${fx.title}`, async () => {
      const base = read(`rules/electronics/${fx.base}.json`);
      const id = await createDraft(client, { kind: base.kind, product: base.product, userId: staff.senior, asOf });
      expect(await saveDraft(client, { id, userId: staff.senior, body: applyEdits(base, fx.edits), asOf })).toEqual([]);
      const written = [await count('Decision'), await count('AuditEvent'), await count('RuleSetVersion')];

      const diff = await impactOfDraft(client, { id });
      const body = (await client.query('SELECT "body" FROM "RuleSetVersion" WHERE "id" = $1', [id])).rows[0].body;
      expect(diff.diffHash).toBe(sha256Hex(body));
      expect(diff.changed.filter((c) => fx.claims.includes(c.claim))).toEqual(fx.expected.changed);
      // one current engine decision per claim: superseded rows and GC-05's sign-off are not cases
      expect(diff.changed.length + diff.unchanged).toBe(await count('Claim'));
      expect([await count('Decision'), await count('AuditEvent'), await count('RuleSetVersion')]).toEqual(written);

      // The coverage report against the stored rows themselves: a listed row is in no stored trace, an unlisted one is in some.
      const { rows: hits } = await client.query(
        `SELECT DISTINCT r->>'ruleId' AS "ruleId", h AS "rowId" FROM "Decision", jsonb_array_elements("explanation"->'rules') r, jsonb_array_elements_text(r->'rowIds') h`);
      const rows: { ruleId: string; rowId: string }[] = body.rules.flatMap((r: { id: string; rows: { id: string }[] }) => r.rows.map((x) => ({ ruleId: r.id, rowId: x.id })));
      const wasHit = (x: { ruleId: string; rowId: string }) => hits.some((h) => h.ruleId === x.ruleId && h.rowId === x.rowId);
      expect(diff.unhit).toEqual(rows.filter((x) => !wasHit(x)));
      expect(diff.unhit.length).toBeGreaterThan(0);
      expect(diff.unhit.length).toBeLessThan(rows.length);
      await dropDraft();
    });
  }

  it('the hash it returns is the one publishing takes, and the publish event carries the counts', async () => {
    const fx = read('fixtures/id/ID-01.json');
    const id = await createDraft(client, { kind: 'plan', product: 'electronics', userId: staff.senior, asOf });
    await saveDraft(client, { id, userId: staff.senior, body: applyEdits(read('rules/electronics/plan-v2.json'), [{ path: ['version'], value: 3 }, ...fx.edits]), asOf });
    const stale = (await impactOfDraft(client, { id })).diffHash;
    await saveDraft(client, { id, userId: staff.senior, body: applyEdits(read('rules/electronics/plan-v2.json'), fx.edits.map((e: { value: number }) => ({ ...e, value: e.value + 1 }))), asOf });
    await expect(publishDraft(client, { id, userId: staff.manager, diffHash: stale, asOf })).rejects.toMatchObject({ code: 'DIFF_STALE' });
    const diff = await impactOfDraft(client, { id });
    await publishDraft(client, { id, userId: staff.manager, diffHash: diff.diffHash, asOf });
    const { rows: [event] } = await client.query(`SELECT "data" FROM "AuditEvent" WHERE "action" = 'ruleset.published' AND "targetId" = $1`, [id]);
    expect(event.data).toMatchObject({ contentHash: diff.diffHash, changed: diff.changed.length, unchanged: diff.unchanged });
    expect(diff.changed.length).toBeGreaterThan(0);
  });

  it('refuses a version that is not a draft, and a draft that does not validate', async () => {
    const { rows: [published] } = await client.query(`SELECT "id" FROM "RuleSetVersion" WHERE "status" = 'published' LIMIT 1`);
    await expect(impactOfDraft(client, { id: published.id })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
    const id = await createDraft(client, { kind: 'ops', product: 'electronics', userId: staff.senior, asOf });
    const issues = await saveDraft(client, { id, userId: staff.senior, body: applyEdits(read('rules/electronics/ops-v3.json'), [{ path: ['rules', 'E23', 'rows', 'E23.pass', 'when', 0, 'fact'], value: 'no.such.fact' }]), asOf });
    expect(issues.length).toBeGreaterThan(0);
    await expect(impactOfDraft(client, { id })).rejects.toMatchObject({ code: 'DRAFT_INVALID', issues });
    await dropDraft();
  });
});
