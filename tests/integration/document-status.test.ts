import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import ev06 from '../../fixtures/ev/EV-06.json';
import ov03 from '../../fixtures/ov/OV-03.json';
import { assignTier, tierOf } from '@/adjudication/authority';
import { publishRuleSet } from '@/adjudication/decisions';
import {
  assertDocumentMove, documentStatus, IllegalDocumentMoveError, LocalDiskDocumentStore, OutOfAuthorityError, readDocumentStatuses, reviewDocument,
  uploadDocument, waiveDocument, type DocAction, type DocStatus,
} from '@/adjudication/documents';
import { powersOf } from '@/rules/authority';
import { staffAt } from '../helpers/tiers';

// Task 3.3 (D53, D54): a document's status is read from rows that are only ever inserted (versions, reviews, a waiver),
// it moves only along EV-06's table, and every move leaves an audit event. The claim lives supply the legal sequences.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
let root: string;
let store: LocalDiskDocumentStore;
const versionIds: Record<string, string> = {};
const TIERS = ['system', 'adjuster', 'senior', 'manager'] as const;
let staff: Record<(typeof TIERS)[number], string>; // one user per tier (D49): the fixtures name the tier, the services take the user
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "TierAssignment", "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
  // The template's resetDb truncates every table, the migration's reference rows included, so whether they are still
  // there depends on which file ran first. Put back exactly what the migration seeds, by running its own statement.
  await client.query(readFileSync('prisma/migrations/20261005010000_document_status/migration.sql', 'utf8')
    .match(/INSERT INTO "DocumentRejectionReason"[^;]+/)![0] + ' ON CONFLICT DO NOTHING');
  staff = await staffAt(client, TIERS);
  root = await mkdtemp(join(tmpdir(), 'adjuster-docs-'));
  store = new LocalDiskDocumentStore(root);
  return () => rm(root, { recursive: true });
});

async function claim(id: string, plan = 'plan-v1') {
  await client.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${id}`, versionIds[plan], {}]);
  await client.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)', [id, `CT-${id}`, {}]);
  return id;
}
const DAY = '2025-09-17';
const upload = (claimId: string, type: string, source = 'claimant') =>
  uploadDocument(client, store, { claimId, type, bytes: new TextEncoder().encode(`${claimId} ${type}`), source, uploadedBy: null });
const accept = (versionId: string) => reviewDocument(client, { versionId, result: 'accepted', userId: null });
const reject = (versionId: string, reason: string | null = 'illegible') => reviewDocument(client, { versionId, result: 'rejected', reason, userId: null });
const waive = (claimId: string, type: string, tier = 'adjuster', reasonText = 'not obtainable') =>
  waiveDocument(client, { claimId, type, reasonText, asOf: DAY, userId: (staff as Record<string, string | undefined>)[tier] ?? null });
const audit = async (claimId: string) => (await client.query(
  `SELECT "action", "data" FROM "AuditEvent" WHERE "targetType" = 'Claim' AND "targetId" = $1 AND "action" LIKE 'document.%' ORDER BY "id"`, [claimId])).rows;
const count = async (table: string) => Number((await client.query(`SELECT count(*) FROM "${table}"`)).rows[0].count);
/** The constraint the database refused `sql` with, or 'accepted'. */
const run = async (sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
    return 'accepted';
  } catch (e) {
    return (e as { constraint?: string }).constraint ?? String(e);
  }
};

describe('EV-06 the table (pure)', () => {
  const ACTIONS: DocAction[] = ['upload', 'accept', 'reject', 'waive'];
  it('allows exactly the fixture’s moves and names the status each leaves', () => {
    for (const from of ev06.statuses as DocStatus[]) for (const action of ACTIONS) {
      const move = ev06.moves.find((m) => m.from === from && m.action === action);
      if (move) expect([from, action, assertDocumentMove(from, action)]).toEqual([from, action, move.to]);
      else expect(() => assertDocumentMove(from, action), `${from} ${action}`).toThrow(IllegalDocumentMoveError);
    }
    expect(ev06.moves).toHaveLength(9);
  });

  it('reads a status from rows: nothing is requested, a later version supersedes, a waiver wins', () => {
    expect(documentStatus([], false)).toEqual({ status: 'requested', versions: {} });
    expect(documentStatus([{ version: 1, review: null }], false)).toEqual({ status: 'received', versions: { 1: 'received' } });
    expect(documentStatus([{ version: 2, review: 'rejected' }, { version: 1, review: 'accepted' }], false))
      .toEqual({ status: 'rejected', versions: { 1: 'superseded', 2: 'rejected' } });
    expect(documentStatus([{ version: 1, review: 'rejected' }], true)).toEqual({ status: 'waived', versions: { 1: 'rejected' } });
    expect(documentStatus([], true)).toEqual({ status: 'waived', versions: {} });
  });

  it('OV-03: powers accumulate up the tier list, and an unknown tier holds none', () => {
    const tiers = read(`rules/electronics/${ov03.ops}.json`).authority;
    const cases = ov03.cases.filter((c) => c.power);
    expect(cases.length).toBeGreaterThan(2);
    for (const c of cases) expect([c.name, powersOf(tiers, c.tier).includes(c.power!)]).toEqual([c.name, !c.expected.lacks.includes('power')]);
    expect(powersOf(tiers, 'nobody')).toEqual([]);
  });
});

describe('claim lives: each document action leaves the statuses the fixture expects', () => {
  const LIVES = ['ev/EV-01', 'ev/EV-02', 'ev/EV-03', 'ev/EV-04', 'ev/EV-05', 'gc/GC-11', 'gc/GC-15'].map((p) => read(`fixtures/${p}.json`));
  type Action = { type: string; doc?: string; version?: string; reason?: string; by?: string; reasonText?: string };
  type Event = { asOf: string; action: Action; expected: { docs: Record<string, DocStatus>; versions: Record<string, DocStatus> } };

  it('EV-01..05, GC-11 and GC-15', async () => {
    let acted = 0;
    for (const fx of LIVES) {
      const id = await claim(`DS-${fx.id}`, fx.plan);
      const ids: Record<string, string> = {};
      const before = (await audit(id)).length;
      const done: string[] = [];
      for (const [i, ev] of (fx.events as Event[]).entries()) {
        const a = ev.action;
        if (a.type === 'upload') ids[a.version!] = (await upload(id, a.doc!)).versionId;
        else if (a.type === 'accept') await accept(ids[a.version!]!);
        else if (a.type === 'reject') await reject(ids[a.version!]!, a.reason);
        else if (a.type === 'waive') await waiveDocument(client, { claimId: id, type: a.doc!, reasonText: a.reasonText!, asOf: ev.asOf, userId: staff[a.by as keyof typeof staff] });
        else { expect(await readDocumentStatuses(client, id), `${fx.id} event ${i}`).toEqual({ docs: ev.expected.docs, versions: ev.expected.versions }); continue; }
        done.push(a.type);
        expect(await readDocumentStatuses(client, id), `${fx.id} event ${i}`).toEqual({ docs: ev.expected.docs, versions: ev.expected.versions });
      }
      // every move audited, in order, and nothing else
      expect((await audit(id)).slice(before).map((r) => r.action)).toEqual(done.map((t) => `document.${{ upload: 'uploaded', accept: 'accepted', reject: 'rejected', waive: 'waived' }[t]}`));
      acted += done.length;
    }
    expect(acted).toBeGreaterThan(20);
  });

  it('records who, why and the move on each audit event', async () => {
    const id = await claim('DS-audit');
    const user = staff.senior;
    const before = (await audit(id)).length;
    const v = await uploadDocument(client, store, { claimId: id, type: 'repairEstimate', bytes: new Uint8Array([1]), source: 'servicer', uploadedBy: null });
    await reviewDocument(client, { versionId: v.versionId, result: 'rejected', reason: 'incomplete', userId: user });
    await waiveDocument(client, { claimId: id, type: 'repairEstimate', reasonText: 'shop closed', asOf: DAY, userId: user });
    expect((await audit(id)).slice(before).map((r) => r.data)).toEqual([
      { type: 'repairEstimate', version: 1, versionId: v.versionId, from: 'requested', to: 'received', source: 'servicer' },
      { type: 'repairEstimate', version: 1, versionId: v.versionId, from: 'received', to: 'rejected', reason: 'incomplete' },
      { type: 'repairEstimate', from: 'rejected', to: 'waived', reasonText: 'shop closed', tier: 'senior', asOf: DAY },
    ]);
    expect((await client.query(`SELECT "tier", "reasonText", "asOf"::text AS "asOf", "waivedBy" FROM "DocumentWaiver" WHERE "claimId" = $1`, [id])).rows)
      .toEqual([{ tier: 'senior', reasonText: 'shop closed', asOf: DAY, waivedBy: user }]);
  });
});

describe('moves the table does not have write nothing', () => {
  it('a version is reviewed once, and not after a later one arrives', async () => {
    const id = await claim('DS-review');
    const v1 = await upload(id, 'repairEstimate');
    const v2 = await upload(id, 'repairEstimate');
    await expect(accept(v1.versionId)).rejects.toMatchObject({ code: 'ILLEGAL_DOCUMENT_MOVE', from: 'superseded', action: 'accept' });
    await reject(v2.versionId);
    await expect(accept(v2.versionId)).rejects.toMatchObject({ from: 'rejected', action: 'accept' });
    await expect(reject(v2.versionId)).rejects.toBeInstanceOf(IllegalDocumentMoveError);
    await expect(accept('00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
    expect(await count('DocumentReview')).toBe(1);
  });

  it('an accepted document is not waived, a waiver is final, and nothing follows it', async () => {
    const id = await claim('DS-waive');
    await accept((await upload(id, 'repairEstimate')).versionId);
    await expect(waive(id, 'repairEstimate')).rejects.toMatchObject({ from: 'accepted', action: 'waive' });
    const photos = await upload(id, 'damagePhotos');
    await waive(id, 'damagePhotos');
    await expect(waive(id, 'damagePhotos')).rejects.toMatchObject({ from: 'waived', action: 'waive' });
    await expect(upload(id, 'damagePhotos')).rejects.toMatchObject({ from: 'waived', action: 'upload' });
    await expect(accept(photos.versionId)).rejects.toMatchObject({ from: 'waived', action: 'accept' });
    expect([await count('DocumentWaiver'), await count('DocumentVersion'), await count('DocumentReview')]).toEqual([1, 2, 1]);
  });

  it('a waiver needs the waive_documents power under the ops version in force, and a reason', async () => {
    const id = await claim('DS-power');
    await expect(waive(id, 'secondEstimate', 'system')).rejects.toBeInstanceOf(OutOfAuthorityError);
    await expect(waive(id, 'secondEstimate', 'system')).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['power'] });
    await expect(waive(id, 'secondEstimate', 'nobody')).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', tier: null, lacks: ['amount', 'power'] });
    await expect(waive(id, 'secondEstimate', 'adjuster', '')).rejects.toMatchObject({ constraint: 'document_waiver_reason' });
    // before any ops version is in force there is no tier list to hold the power under
    await expect(waiveDocument(client, { claimId: id, type: 'secondEstimate', reasonText: 'x', asOf: '2019-01-01', userId: staff.adjuster })).rejects.toThrow(/NO_EFFECTIVE_VERSION/);
    expect(await count('DocumentWaiver')).toBe(0);
    await waive(id, 'secondEstimate', 'manager'); // powers accumulate upward
    expect((await readDocumentStatuses(client, id)).docs.secondEstimate).toBe('waived');
  });

  it('refuses a document type the fact dictionary does not name, and a claim with no contract on file', async () => {
    const id = await claim('DS-type');
    await expect(upload(id, 'passport')).rejects.toThrow(/not a document type/);
    await expect(waive(id, 'passport')).rejects.toThrow(/not a document type/);
    await client.query(`INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ('DS-orphan', 'CT-none', '{}')`);
    await expect(upload('DS-orphan', 'repairEstimate')).rejects.toThrow(/no contract on file/);
    expect([await count('Document'), await count('DocumentWaiver')]).toEqual([0, 0]);
  });
});

describe('the database rules', () => {
  it('holds exactly the fixture’s rejection reasons, and a review names one of them exactly when it rejects', async () => {
    expect((await client.query(`SELECT "code" FROM "DocumentRejectionReason"`)).rows.map((r) => r.code).sort()).toEqual([...ev06.rejectionReasons].sort());
    const id = await claim('DS-reason');
    const v = await upload(id, 'repairEstimate');
    await expect(reject(v.versionId, 'smudged')).rejects.toMatchObject({ constraint: 'DocumentReview_reasonCode_fkey' });
    await expect(reject(v.versionId, null)).rejects.toMatchObject({ constraint: 'document_review_reason' });
    await expect(reviewDocument(client, { versionId: v.versionId, result: 'accepted', reason: 'illegible', userId: null })).rejects.toMatchObject({ constraint: 'document_review_reason' });
    const insert = (result: string) => run(`INSERT INTO "DocumentReview" ("id", "versionId", "result") VALUES (gen_random_uuid(), $1, $2)`, [v.versionId, result]);
    expect(await insert('received')).toBe('document_review_result');
    expect(await count('DocumentReview')).toBe(0);
    for (const reason of ev06.rejectionReasons) await reject((await upload(id, 'repairEstimate')).versionId, reason);
    expect(await count('DocumentReview')).toBe(5);
    expect(await insert('accepted')).toBe('accepted'); // v is superseded: the table is the service's, the database only keeps one review per version
    expect(await insert('accepted')).toBe('DocumentReview_versionId_key');
  });

  it('takes a source from the list only', async () => {
    const id = await claim('DS-source');
    for (const source of ['claimant', 'servicer', 'staff']) await upload(id, 'damagePhotos', source);
    await expect(upload(id, 'damagePhotos', 'fax')).rejects.toMatchObject({ constraint: 'document_version_source' });
    expect(await count('DocumentVersion')).toBe(3);
  });

  it('D49: a waiver is made at the tier its user holds that moment, and the row keeps it when the user moves', async () => {
    const id = await claim('DS-tier');
    const user = staff.system;
    await expect(waiveDocument(client, { claimId: id, type: 'secondEstimate', reasonText: 'x', asOf: DAY, userId: user })).rejects.toMatchObject({ tier: 'system', lacks: ['power'] });
    await assignTier(client, { userId: user, tier: 'adjuster', by: staff.manager });
    await waiveDocument(client, { claimId: id, type: 'secondEstimate', reasonText: 'x', asOf: DAY, userId: user });
    await assignTier(client, { userId: user, tier: null, by: staff.manager });
    expect(await tierOf(client, user)).toBeNull();
    await expect(waiveDocument(client, { claimId: id, type: 'transferProof', reasonText: 'x', asOf: DAY, userId: user })).rejects.toMatchObject({ tier: null, lacks: ['amount', 'power'] });
    expect((await client.query(`SELECT "type", "tier" FROM "DocumentWaiver" WHERE "claimId" = $1`, [id])).rows).toEqual([{ type: 'secondEstimate', tier: 'adjuster' }]);
    expect((await client.query(`SELECT "tier", "assignedBy" FROM "TierAssignment" WHERE "userId" = $1 ORDER BY "id"`, [user])).rows)
      .toEqual([{ tier: 'system', assignedBy: null }, { tier: 'adjuster', assignedBy: staff.manager }, { tier: null, assignedBy: staff.manager }]);
    expect((await client.query(`SELECT "actorUserId", "data" FROM "AuditEvent" WHERE "action" = 'authority.tier_assigned' AND "targetId" = $1 ORDER BY "id"`, [user])).rows)
      .toEqual([{ actorUserId: null, data: { tier: 'system' } }, { actorUserId: staff.manager, data: { tier: 'adjuster' } }, { actorUserId: staff.manager, data: { tier: null } }]);
    expect([await tierOf(client, null), await tierOf(client, '00000000-0000-4000-8000-00000000dead')]).toEqual([null, null]);
    expect(await run(`UPDATE "TierAssignment" SET "tier" = 'manager'`)).toBe('document_append_only');
    expect(await run(`DELETE FROM "TierAssignment"`)).toBe('document_append_only');
    expect(await run(`INSERT INTO "TierAssignment" ("userId", "tier") VALUES ($1, '')`, [user])).toBe('tier_assignment_tier');
  });

  it('refuses UPDATE and DELETE of a review and of a waiver', async () => {
    const id = await claim('DS-append');
    await reject((await upload(id, 'repairEstimate')).versionId);
    await waive(id, 'secondEstimate');
    expect(await run(`UPDATE "DocumentReview" SET "result" = 'accepted', "reasonCode" = NULL`)).toBe('document_append_only');
    expect(await run(`DELETE FROM "DocumentReview"`)).toBe('document_append_only');
    expect(await run(`UPDATE "DocumentWaiver" SET "tier" = 'manager'`)).toBe('document_append_only');
    expect(await run(`DELETE FROM "DocumentWaiver"`)).toBe('document_append_only');
    expect(await run(`INSERT INTO "DocumentWaiver" ("id", "claimId", "type", "reasonText", "tier", "asOf") VALUES (gen_random_uuid(), $1, 'secondEstimate', 'again', 'adjuster', $2)`, [id, DAY]))
      .toBe('DocumentWaiver_claimId_type_key');
    expect(await run(`INSERT INTO "DocumentWaiver" ("id", "claimId", "type", "reasonText", "tier", "asOf") VALUES (gen_random_uuid(), $1, 'transferProof', 'x', '', $2)`, [id, DAY]))
      .toBe('document_waiver_tier');
  });
});
