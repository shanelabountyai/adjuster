import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import RuleSets from '@/app/o/[org]/rules/page';
import RuleSet from '@/app/o/[org]/rules/[id]/page';
import { saveRuleDraft, startDraft } from '@/app/o/[org]/rules/[id]/actions';
import { assignTier } from '@/adjudication/authority';
import { publishRuleSet } from '@/adjudication/decisions';
import { createDraft } from '@/adjudication/drafts';
import { resetAuthTables } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';

// Task 4.9. The rule-set pages print what is stored: every version of both products, and one version as tables.
// Task 4.10: a draft is shown as the editor, and saving it goes through saveDraft.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

const ids: Record<string, string> = {};
let draftId: string;
let adaId: string;
let orgId: string;
beforeAll(async () => {
  await client.connect();
  await resetAuthTables();
  for (const product of ['electronics', 'furniture'])
    for (const f of readdirSync(`rules/${product}`).filter((n) => !n.startsWith('facts')).sort())
      ids[`${product}/${f}`] = await publishRuleSet(client, read(`rules/${product}/${f}`));
  const org = await makeOrg();
  orgId = org.id;
  const ada = await addMember(org.id, 'member', 'ada@example.test');
  await client.query('UPDATE "User" SET "name" = $2 WHERE "id" = $1', [ada.id, 'Ada Author']);
  await assignTier(client, { userId: ada.id, tier: 'senior', by: null });
  draftId = await createDraft(client, { kind: 'plan', product: 'electronics', userId: ada.id, asOf: read('rules/electronics/ops-v3.json').effectiveFrom });
  adaId = ada.id;
});

const page = async (id?: string, issues?: string) => {
  await actAs(adaId, 'acme'); // the jar is emptied before each test
  return renderToStaticMarkup(id
    ? await RuleSet({ params: Promise.resolve({ org: 'acme', id }), searchParams: Promise.resolve({ issues }) })
    : await RuleSets({ params: Promise.resolve({ org: 'acme' }) }));
};
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const landing = async (p: Promise<unknown>) => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof NavSignal && e.to) return new URL(e.to, 'http://x');
    throw e;
  }
};
const select = (html: string, name: string) => html.match(new RegExp(`<select name="${name.replaceAll('.', '\\.')}"[^]*?</select>`))![0];

describe('rule-set pages', () => {
  it('lists every version by product and kind, a seeded row as "file" and a draft by its author', async () => {
    const html = await page();
    for (const h of ['electronics ops', 'electronics plan', 'furniture ops', 'furniture plan']) expect(html).toContain(`<h2>${h}</h2>`);
    expect(html.match(/<tr>/g)).toHaveLength(4 + 7 + 1); // a header per group, every file, the draft
    expect(html).toContain('<td>draft</td>');
    expect(html).toContain('<td>Ada Author</td>');
    expect(html).toContain(`href="/o/acme/rules/${draftId}">v3</a>`);
  });

  it('reads one published version as tables', async () => {
    const html = await page(ids['electronics/ops-v3.json']);
    expect(html).toContain('<h1>electronics ops v3</h1>');
    expect(html).toContain('<td>manager</td><td>no limit</td><td>ex_gratia, publish_rules</td>');
    expect(html).toContain('<td>senior</td><td>$2500.00</td>');
    const plan = await page(ids['furniture/plan-v1.json']);
    expect(plan).toContain('<h2>Payout</h2>');
    expect(plan).toMatch(/<h2>E101 /);
  });

  it('shows a draft as the editor: operators by fact type, a typed input, no issues before a save', async () => {
    const html = await page(draftId);
    expect(html).toContain('Save draft');
    expect(select(html, 'rules.2.rows.1.when.0.op')).not.toContain('>lt<'); // contract.planCode is an enum
    expect(select(html, 'rules.2.rows.1.when.1.op')).toContain('>between<'); // d.daysSinceStart is ordered
    expect(select(html, 'rules.2.rows.1.when.0.value')).toContain('>premier<');
    const deductible = html.match(/<input[^>]*name="lookups\.0\.rows\.0\.value"[^>]*>/)![0];
    expect(deductible).toContain('type="number"');
    expect(deductible).toContain('value="10000"');
    expect(html).not.toContain('role="alert"');
  });

  it('saves the form through saveDraft and shows its issues beside the cell they name', async () => {
    await actAs(adaId, 'acme');
    const to = await landing(saveRuleDraft('acme', form({ id: draftId, 'lookups.0.rows.0.value': '12500', 'rules.2.rows.1.when.1.value': 'soon', _do: 'save' })));
    expect((to as URL).pathname).toBe(`/o/acme/rules/${draftId}`);
    const { rows: [row] } = await client.query('SELECT "body" FROM "RuleSetVersion" WHERE "id" = $1', [draftId]);
    expect(row.body.lookups[0].rows[0].value).toBe(12500);

    const html = await page(draftId, (to as URL).searchParams.get('issues')!);
    expect(html).toContain('Saved with 1 issue(s)');
    const cell = html.indexOf('name="rules.2.rows.1.when.1.value"');
    expect(html.indexOf('TYPE_MISMATCH', cell)).toBeLessThan(html.indexOf('name="rules.2.rows.2.', cell));
    expect(await page(draftId, 'not base64 json')).not.toContain('role="alert"');
  });

  it('returns the service refusal: no tier cannot save, a kind with an open draft cannot start another', async () => {
    const bob = await addMember(orgId, 'member', 'bob@example.test');
    await actAs(bob.id, 'acme');
    expect(await saveRuleDraft('acme', form({ id: draftId }))).toEqual({ error: expect.stringContaining('lacks power') });
    await actAs(adaId, 'acme');
    expect(await startDraft('acme', form({ id: ids['electronics/plan-v2.json']! }))).toEqual({ error: expect.stringContaining('DRAFT_EXISTS') });
    expect(await page(ids['electronics/plan-v2.json'])).toContain(`href="/o/acme/rules/${draftId}">Open draft v3</a>`);
  });

  it('starts a draft from a published version and lands on it', async () => {
    await actAs(adaId, 'acme');
    const to = await landing(startDraft('acme', form({ id: ids['furniture/ops-v1.json']! })));
    const { rows: [made] } = await client.query(`SELECT "id" FROM "RuleSetVersion" WHERE "product" = 'furniture' AND "kind" = 'ops' AND "status" = 'draft'`);
    expect((to as URL).pathname).toBe(`/o/acme/rules/${made.id}`);
  });

  it('shows a draft that does not parse as its JSON, and an unknown id as not found', async () => {
    await client.query(`UPDATE "RuleSetVersion" SET "body" = '{"half": "typed"}' WHERE "id" = $1`, [draftId]);
    expect(await page(draftId)).toContain('does not parse as a rule set yet');
    await expect(page('00000000-0000-0000-0000-000000000000')).rejects.toThrow('notFound');
    await expect(page('not-a-uuid')).rejects.toThrow('notFound');
  });
});
