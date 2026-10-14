import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import RuleSets from '@/app/o/[org]/rules/page';
import RuleSet from '@/app/o/[org]/rules/[id]/page';
import { assignTier } from '@/adjudication/authority';
import { publishRuleSet } from '@/adjudication/decisions';
import { createDraft } from '@/adjudication/drafts';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

// Task 4.9. The rule-set pages print what is stored: every version of both products, and one version as tables.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

const ids: Record<string, string> = {};
let draftId: string;
let adaId: string;
beforeAll(async () => {
  await client.connect();
  await resetAuthTables();
  for (const product of ['electronics', 'furniture'])
    for (const f of readdirSync(`rules/${product}`).filter((n) => !n.startsWith('facts')).sort())
      ids[`${product}/${f}`] = await publishRuleSet(client, read(`rules/${product}/${f}`));
  const org = await makeOrg();
  const ada = await addMember(org.id, 'member', 'ada@example.test');
  await client.query('UPDATE "User" SET "name" = $2 WHERE "id" = $1', [ada.id, 'Ada Author']);
  await assignTier(client, { userId: ada.id, tier: 'senior', by: null });
  draftId = await createDraft(client, { kind: 'plan', product: 'electronics', userId: ada.id, asOf: read('rules/electronics/ops-v3.json').effectiveFrom });
  adaId = ada.id;
});

const page = async (id?: string) => {
  await actAs(adaId, 'acme'); // the jar is emptied before each test
  return renderToStaticMarkup(id ? await RuleSet({ params: Promise.resolve({ org: 'acme', id }) }) : await RuleSets({ params: Promise.resolve({ org: 'acme' }) }));
};

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

  it('shows a draft that does not parse as its JSON, and an unknown id as not found', async () => {
    await client.query(`UPDATE "RuleSetVersion" SET "body" = '{"half": "typed"}' WHERE "id" = $1`, [draftId]);
    expect(await page(draftId)).toContain('does not parse as a rule set yet');
    await expect(page('00000000-0000-0000-0000-000000000000')).rejects.toThrow('notFound');
    await expect(page('not-a-uuid')).rejects.toThrow('notFound');
  });
});
