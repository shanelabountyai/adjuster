import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { assignTier } from '@/adjudication/authority';
import { publishRuleSet } from '@/adjudication/decisions';
import { createDraft, exportRules, publishDraft, saveDraft } from '@/adjudication/drafts';
import { sha256Hex } from '@/rules/canonical';
import { applyEdits } from '../helpers/edits';

// Tasks 4.2 and 4.3 (D70, D77). A draft row is created as a copy of the latest published version, saved by whoever
// holds `author_rules` and published by someone else holding `publish_rules`. AU-05 is the fixture; every step of it,
// allowed or refused, runs through the services.

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
const nextDay = new Date(Date.parse(asOf) + 86400000).toISOString().slice(0, 10);
// Every save carries different content, so a revision is a body: the n-th save sets the first reminder day to n.
// It also moves the effective date off its base's day, which a publish needs (D77 a).
const edited = (n: number) => applyEdits(opsFile, [{ path: ['reminders', 'firstDay'], value: n }, { path: ['effectiveFrom'], value: nextDay }]);
const hashOf = async (id: string) => sha256Hex((await rowOf(id)).body);
const codeOf = (e: unknown) => (e as { code?: string }).code ?? String(e);

describe('AU-05: the life of a version row', () => {
  it('the fixture names the moves and refusals this task builds', () => {
    expect(fx.moves.map((m: { action: string; power: string }) => [m.action, m.power])).toEqual([['create', 'author_rules'], ['save', 'author_rules'], ['publish', 'publish_rules']]);
    expect(fx.refusals).toEqual(['DRAFT_EXISTS', 'NOT_A_DRAFT', 'OUT_OF_AUTHORITY', 'PUBLISHER_IS_AUTHOR', 'DIFF_STALE']);
    expect(opsFile.version).toBe(fx.latestPublished);
  });

  for (const sc of fx.scenarios) {
    it(sc.name, async () => {
      let id: string | undefined;
      let saves = 0;
      let seen: string[] = []; // the content hash after each save, which is what an impact diff of that revision ran on
      for (const step of sc.steps) {
        const userId = await userFor(step.by);
        let error: string | null = null;
        try {
          if (step.action === 'create') {
            id = await createDraft(client, { kind: 'ops', product: opsFile.product, userId, asOf });
            saves = 0;
            seen = [await hashOf(id)];
          } else if (step.action === 'save') {
            await saveDraft(client, { id: id!, userId, body: edited(saves + 1), asOf });
            saves += 1;
            seen[saves] = await hashOf(id!);
          } else await publishDraft(client, { id: id!, userId, diffHash: seen[step.sawRevision]!, asOf });
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

  const manager = () => userFor({ user: 'u-manager-1', tier: 'manager' });
  const publish = async (id: string, diffHash?: string) => publishDraft(client, { id, userId: await manager(), diffHash: diffHash ?? await hashOf(id), asOf });

  it('4.3 a publish freezes the row: hash of the stored body, who and when, audited, and closed to any later write', async () => {
    const id = await draftOf('ops');
    await saveDraft(client, { id, userId: await senior(), body: edited(1), asOf });
    await publish(id);
    const row = await rowOf(id);
    expect([row.status, row.contentHash, row.publishedBy, row.publishedAt instanceof Date]).toEqual(['published', sha256Hex(row.body), await manager(), true]);
    expect(await events(id, 'ruleset.published')).toEqual([{ actorUserId: await manager(), data: { contentHash: row.contentHash, effectiveFrom: nextDay } }]);
    await expect(client.query(`UPDATE "RuleSetVersion" SET "body" = '{}' WHERE "id" = $1`, [id])).rejects.toThrow();
  });

  it('4.3 an invalid draft is not published, and the refusal carries the issues', async () => {
    const au = read('fixtures/au/AU-01.json');
    const base = read(`rules/electronics/${au.base}.json`);
    const id = await draftOf(base.kind);
    await saveDraft(client, { id, userId: await senior(), body: applyEdits(base, au.edits), asOf });
    await expect(publish(id)).rejects.toMatchObject({ code: 'DRAFT_INVALID', issues: au.expectedCodes.map((code: string) => expect.objectContaining({ code })) });
    await saveDraft(client, { id, userId: await senior(), body: { ...edited(1), factDictionaryHash: 'f'.repeat(64) }, asOf });
    await expect(publish(id)).rejects.toMatchObject({ code: 'DRAFT_INVALID', issues: [expect.objectContaining({ code: 'DICTIONARY_HASH' })] });
    expect((await rowOf(id)).status).toBe('draft');
  });

  it('4.3 (D77 a) an ops draft still on a published ops version\'s day is refused; a plan draft is not', async () => {
    const ops = await draftOf('ops');
    await expect(publish(ops)).rejects.toMatchObject({ code: 'OPS_SAME_DAY' });
    await saveDraft(client, { id: ops, userId: await senior(), body: { ...opsFile, effectiveFrom: read('rules/electronics/ops-v1.json').effectiveFrom }, asOf });
    await expect(publish(ops)).rejects.toMatchObject({ code: 'OPS_SAME_DAY' });
    expect((await rowOf(ops)).status).toBe('draft');
    await publish(await draftOf('plan'));
  });

  it('4.3 publish refusals come in D70\'s order', async () => {
    const id = await draftOf('ops'); // unedited: stale to a wrong hash, and on its base's day
    const as = (userId: string, diffHash: string) => publishDraft(client, { id, userId, diffHash, asOf });
    await expect(as(await userFor({ user: 'u-adjuster-1', tier: 'adjuster' }), 'x')).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY' });
    await assignTier(client, { userId: await senior(), tier: 'manager', by: null }); // the author, now holding the power
    await expect(as(await senior(), 'x')).rejects.toMatchObject({ code: 'PUBLISHER_IS_AUTHOR' });
    await expect(as(await manager(), 'x')).rejects.toMatchObject({ code: 'DIFF_STALE' });
    await expect(as(await manager(), await hashOf(id))).rejects.toMatchObject({ code: 'OPS_SAME_DAY' });
    await expect(publishDraft(client, { id: versionIds[fx.ops]!, userId: await senior(), diffHash: 'x', asOf })).rejects.toMatchObject({ code: 'NOT_A_DRAFT' });
  });

  it('4.3 (D69) the export writes a published version that has no file, once, and never over a different one', async () => {
    expect(await exportRules(client, { write: false })).toEqual([]); // the five loaded from files
    const id = await draftOf('ops');
    expect(await exportRules(client, { write: false })).toEqual([]); // a draft is not exported
    await saveDraft(client, { id, userId: await senior(), body: edited(1), asOf });
    await publish(id);
    const file = `ops-v${fx.latestPublished + 1}.json`;
    expect(await exportRules(client, { write: false })).toEqual([join('rules', opsFile.product, file)]);

    const root = mkdtempSync(join(tmpdir(), 'adjuster-rules-'));
    expect(await exportRules(client, { write: false, root })).toHaveLength(6);
    expect(await exportRules(client, { write: true, root })).toHaveLength(6);
    expect(sha256Hex(read(join(root, opsFile.product, file)))).toBe((await rowOf(id)).contentHash);
    expect(await exportRules(client, { write: true, root })).toEqual([]);
    writeFileSync(join(root, opsFile.product, file), JSON.stringify(opsFile));
    await expect(exportRules(client, { write: true, root })).rejects.toThrow('RULE_FILE_MISMATCH');
    expect(read(join(root, opsFile.product, file))).toEqual(opsFile);
  });
});
