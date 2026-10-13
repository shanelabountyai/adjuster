import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assignTier } from '@/adjudication/authority';
import { publishRuleSet } from '@/adjudication/decisions';
import { createDraft, saveDraft } from '@/adjudication/drafts';
import { sha256Hex } from '@/rules/canonical';
import { applyEdits } from '../helpers/edits';

// Task 4.2 (D70). A draft row is created as a copy of the latest published version and saved by whoever holds
// `author_rules`. AU-05 is the fixture; its `create` and `save` steps run through the services. `publishDraft` is 4.3:
// until then a publish the fixture allows is applied here by hand, and one it refuses is skipped.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fx = read('fixtures/au/AU-05.json');
const opsFile = read(`rules/electronics/${fx.ops}.json`);
const asOf = opsFile.effectiveFrom; // the first day the fixture's ops version, and so `author_rules`, is in force
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

const versionIds: Record<string, string> = {};
let users: Record<string, string>; // the fixture's user name → a user id
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "TierAssignment", "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2', 'ops-v3']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
  users = {};
});

const userFor = async (by: { user: string; tier: string }) => {
  if (!users[by.user]) await assignTier(client, { userId: (users[by.user] = randomUUID()), tier: by.tier, by: null });
  return users[by.user]!;
};
const nameOf = (id: string | null) => Object.keys(users).find((n) => users[n] === id) ?? id;
const rowOf = async (id: string) => (await client.query('SELECT * FROM "RuleSetVersion" WHERE "id" = $1', [id])).rows[0];
const events = async (id: string, action: string) =>
  (await client.query('SELECT "actorUserId", "data" FROM "AuditEvent" WHERE "targetType" = \'RuleSetVersion\' AND "targetId" = $1 AND "action" = $2 ORDER BY "id"', [id, action])).rows;
/** The newest ops row as AU-05 writes it, or null while the latest published version is still the newest. */
const newest = async () => {
  const r = (await client.query('SELECT * FROM "RuleSetVersion" WHERE "kind" = \'ops\' AND "product" = $1 AND "version" > $2 ORDER BY "version" DESC LIMIT 1', [opsFile.product, fx.latestPublished])).rows[0];
  return r ? { status: r.status, version: r.version, authoredBy: nameOf(r.authoredBy), publishedBy: nameOf(r.publishedBy), revision: (await events(r.id, 'ruleset.draft_saved')).length } : null;
};
// Every save carries different content, so a revision is a body: the n-th save sets the first reminder day to n.
const edited = (n: number) => applyEdits(opsFile, [{ path: ['reminders', 'firstDay'], value: n }]);
const codeOf = (e: unknown) => (e as { code?: string }).code ?? String(e);

describe('AU-05: the life of a version row, create and save', () => {
  it('the fixture names the moves and refusals this task builds', () => {
    expect(fx.moves.map((m: { action: string; power: string }) => [m.action, m.power])).toEqual([['create', 'author_rules'], ['save', 'author_rules'], ['publish', 'publish_rules']]);
    expect(fx.refusals.slice(0, 3)).toEqual(['DRAFT_EXISTS', 'NOT_A_DRAFT', 'OUT_OF_AUTHORITY']);
    expect(opsFile.version).toBe(fx.latestPublished);
  });

  for (const sc of fx.scenarios) {
    it(sc.name, async () => {
      let id: string | undefined;
      let saves = 0;
      for (const step of sc.steps) {
        const userId = await userFor(step.by);
        let error: string | null = null;
        try {
          if (step.action === 'create') {
            id = await createDraft(client, { kind: 'ops', product: opsFile.product, userId, asOf });
            saves = 0;
          } else if (step.action === 'save') {
            await saveDraft(client, { id: id!, userId, body: edited(saves + 1), asOf });
            saves += 1;
          } else if (step.expected.allowed) {
            const body = (await rowOf(id!)).body;
            await client.query('UPDATE "RuleSetVersion" SET "status" = \'published\', "contentHash" = $2, "publishedAt" = now(), "publishedBy" = $3 WHERE "id" = $1', [id, sha256Hex(body), userId]);
          } else continue;
        } catch (e) {
          error = codeOf(e);
        }
        expect([step.action, error]).toEqual([step.action, step.expected.error]);
        expect(await newest()).toEqual(step.expected.row);
      }
    });
  }
});

describe('a draft row', () => {
  const senior = () => userFor({ user: 'u-senior-1', tier: 'senior' });
  const draftOf = async (kind: 'plan' | 'ops') => createDraft(client, { kind, product: opsFile.product, userId: await senior(), asOf });

  it('is a copy of the latest published version, numbered one above it, and its creation is audited', async () => {
    const id = await draftOf('ops');
    const row = await rowOf(id);
    expect(row.body).toEqual({ ...opsFile, version: fx.latestPublished + 1 });
    expect([row.basedOnId, row.contentHash, row.publishedAt]).toEqual([versionIds[fx.ops], null, null]);
    expect(await events(id, 'ruleset.draft_created')).toEqual([{ actorUserId: await senior(), data: { kind: 'ops', product: opsFile.product, version: fx.latestPublished + 1, basedOnId: versionIds[fx.ops] } }]);
    expect((await rowOf(versionIds[fx.ops]!)).authoredBy).toBeNull(); // a version loaded from a file has no author
  });

  it('the power is read from the ops version in force that day: the day before it names author_rules, nobody drafts', async () => {
    const dayBefore = new Date(Date.parse(asOf) - 86400000).toISOString().slice(0, 10);
    await expect(createDraft(client, { kind: 'ops', product: opsFile.product, userId: await senior(), asOf: dayBefore })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY' });
    expect(await newest()).toBeNull();
  });

  for (const n of ['AU-01', 'AU-02', 'AU-03', 'AU-04']) {
    const au = read(`fixtures/au/${n}.json`);
    it(`${n}: saving an invalid draft stores it and returns its issues`, async () => {
      const base = read(`rules/electronics/${au.base}.json`);
      const id = await draftOf(base.kind);
      const before = (await rowOf(id)).body;
      const issues = await saveDraft(client, { id, userId: await senior(), body: applyEdits(base, au.edits), asOf });
      expect(issues.map((i) => i.code)).toEqual(au.expectedCodes);
      expect((await rowOf(id)).body).toEqual({ ...applyEdits(base, au.edits), version: before.version });
      expect((await events(id, 'ruleset.draft_saved'))[0].data).toEqual({ issues: au.expectedCodes });
    });
  }

  it('refusals come in order: an open draft, then a closed row, before authority is looked at', async () => {
    const adjuster = await userFor({ user: 'u-adjuster-1', tier: 'adjuster' });
    await draftOf('ops');
    await expect(createDraft(client, { kind: 'ops', product: opsFile.product, userId: adjuster, asOf })).rejects.toMatchObject({ code: 'DRAFT_EXISTS' });
    await expect(saveDraft(client, { id: versionIds[fx.ops]!, userId: adjuster, body: opsFile, asOf })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
    await expect(saveDraft(client, { id: randomUUID(), userId: adjuster, body: opsFile, asOf })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
  });

  it('a save cannot change which version the row is, or which dictionary it reads', async () => {
    const id = await draftOf('ops');
    const issues = await saveDraft(client, { id, userId: await senior(), asOf, body: { ...edited(9), kind: 'plan', product: 'other', version: 99, factDictionary: '../../package' } });
    expect(issues).toEqual([]);
    expect((await rowOf(id)).body).toEqual({ ...edited(9), version: fx.latestPublished + 1 });
  });

  it('the effective date follows the saved body', async () => {
    const id = await draftOf('ops');
    await saveDraft(client, { id, userId: await senior(), asOf, body: { ...opsFile, effectiveFrom: '2027-01-01' } });
    expect((await client.query('SELECT "effectiveFrom"::text AS d FROM "RuleSetVersion" WHERE "id" = $1', [id])).rows[0].d).toBe('2027-01-01');
  });

  it('the database refuses a second open draft and a publisher who is the author', async () => {
    const id = await draftOf('ops');
    const insert = client.query(`INSERT INTO "RuleSetVersion" ("id", "kind", "product", "version", "status", "effectiveFrom", "body") VALUES (gen_random_uuid(), 'ops', $1, 99, 'draft', '2027-01-01', '{}')`, [opsFile.product]);
    await expect(insert).rejects.toMatchObject({ constraint: 'RuleSetVersion_one_draft' });
    const publish = client.query('UPDATE "RuleSetVersion" SET "status" = \'published\', "contentHash" = $2, "publishedAt" = now(), "publishedBy" = "authoredBy" WHERE "id" = $1', [id, 'a'.repeat(64)]);
    await expect(publish).rejects.toMatchObject({ constraint: 'ruleset_author_not_publisher' });
    expect((await rowOf(id)).status).toBe('draft');
  });
});
