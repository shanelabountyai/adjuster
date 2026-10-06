import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { publishRuleSet, verifyDecisions } from '@/adjudication/decisions';
import { enterFact, LocalDiskDocumentStore, readDocumentStatuses, readEvidence, reviewDocument, uploadDocument } from '@/adjudication/documents';
import { acceptEvidence, adjudicateClaim, openClaim, waiveEvidence } from '@/adjudication/pipeline';

// Task 3.4 (D47, D55): a fact is a row someone entered, from a document version or on their own word. The snapshot
// reads those rows, a document's facts count only while its version is accepted, and the decision names the versions.
// Task 3.5 (D51a, D51d, D51f, D56): filing, accepting and waiving decide the claim themselves; an upload does not.
// Every event is checked against the fixture: status, documents, the decision and what each rule that did not pass is missing.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
let store: LocalDiskDocumentStore;
const versionIds: Record<string, string> = {};
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
  const root = await mkdtemp(join(tmpdir(), 'adjuster-facts-'));
  store = new LocalDiskDocumentStore(root);
  return () => rm(root, { recursive: true });
});

const STAFF = '00000000-0000-4000-8000-000000000001';
const onContract = ([k]: [string, unknown]) => k.startsWith('contract.') || k.startsWith('product.');
const upload = (claimId: string, type: string, n = 1) =>
  uploadDocument(client, store, { claimId, type, bytes: new TextEncoder().encode(`${claimId} ${type} ${n}`), source: 'claimant', uploadedBy: null });
const accept = (versionId: string, facts?: Record<string, unknown>) => reviewDocument(client, { versionId, result: 'accepted', userId: null, facts });
const decision = async (id: string | null) => (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [id])).rows[0];

type Action = { type: string; facts: Record<string, unknown>; doc: string; version: string; by: string; reasonText: string };
type NotPassed = { ruleId: string; result: string; missing: string[] };
type Expected = { row: number; outcome: string; payableCents: number | null; reasons: string[]; notPassed: NotPassed[]; documentVersions: string[]; supersedes: number | null };
type Life = { plan: string; events: { asOf: string; action: Action; expected: { claimStatus: string; docs: Record<string, string>; decisionRows: number; decision: Expected } }[] };

/** Plays a claim life's open, upload, accept and waive events through the services and returns the label of each version id. */
async function play(id: string, fx: Life) {
  const label = new Map<string, string>();
  const idOf = (l: string) => [...label].find(([, v]) => v === l)![0];
  for (const [i, { asOf, action: a, expected: e }] of fx.events.entries()) {
    if (a.type === 'open') {
      const facts = Object.entries(a.facts);
      await client.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${id}`, versionIds[fx.plan], Object.fromEntries(facts.filter(onContract))]);
      await openClaim(client, { id, contractId: `CT-${id}`, facts: Object.fromEntries(facts.filter((f) => !onContract(f))) as never }, asOf);
    } else if (a.type === 'upload') label.set((await upload(id, a.doc, i)).versionId, a.version);
    else if (a.type === 'accept') await acceptEvidence(client, { versionId: idOf(a.version), facts: a.facts, userId: null }, asOf);
    else if (a.type === 'waive') await waiveEvidence(client, { claimId: id, type: a.doc, tier: a.by, reasonText: a.reasonText, asOf, userId: null });
    else if (a.type !== 'tick') throw new Error(`play: ${a.type}`); // the no-response job is 3.6; it writes no decision

    const rows = (await client.query('SELECT * FROM "Decision" WHERE "claimId" = $1 ORDER BY "createdAt"', [id])).rows;
    const d = rows[e.decision.row];
    expect([i, rows.length, d.outcome, d.payableCents, d.explanation.decision.reasons, d.documentVersions.map((v: string) => label.get(v)).sort()])
      .toEqual([i, e.decisionRows, e.decision.outcome, e.decision.payableCents, e.decision.reasons, e.decision.documentVersions]);
    expect([i, d.supersedesId]).toEqual([i, e.decision.supersedes === null ? null : rows[e.decision.supersedes].id]);
    const notPassed = (d.explanation.rules as NotPassed[]).filter((r) => r.result !== 'PASS').map(({ ruleId, result, missing }) => ({ ruleId, result, missing }));
    expect([i, notPassed]).toEqual([i, e.decision.notPassed]);
    const { status } = (await client.query('SELECT "status" FROM "Claim" WHERE "id" = $1', [id])).rows[0];
    expect([i, status, (await readDocumentStatuses(client, id)).docs]).toEqual([i, e.claimStatus, e.docs]);
  }
  return label;
}

describe('evidence in the pipeline', () => {
  it('EV-01: FNOL pends, each required document is a reason, and a rule names only the facts that are themselves unknown', async () => {
    await play('E-EV-01', read('fixtures/ev/EV-01.json'));
  });

  it('EV-02: a claim deniable at FNOL is denied without asking for a document, and no later acceptance is taken', async () => {
    await play('E-EV-02', read('fixtures/ev/EV-02.json'));
    const v = await upload('E-EV-02', 'repairEstimate');
    await expect(acceptEvidence(client, { versionId: v.versionId, facts: { 'claim.coveredRepairCents': 30000 }, userId: null }, '2025-09-18')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    const n = (await client.query('SELECT (SELECT count(*) FROM "DocumentReview")::int + (SELECT count(*) FROM "ClaimFact")::int + (SELECT count(*) FROM "Decision")::int AS n')).rows[0].n;
    expect([n, (await readDocumentStatuses(client, 'E-EV-02')).docs.repairEstimate]).toEqual([1, 'received']);
  });

  it('GC-15 to its waiver: waiving the second estimate decides the claim, which is referred', async () => {
    const fx: Life = read('fixtures/gc/GC-15.json');
    const upTo = fx.events.findIndex((e) => e.action.type === 'waive');
    await play('E-GC-15', { ...fx, events: fx.events.slice(0, upTo + 1) });
    expect((await verifyDecisions(client)).failures).toEqual([]);
  });
});

describe('evidence facts', () => {
  it('EV-04: each decision names the versions it relied on, and a replacement with the same content supersedes', async () => {
    await play('E-EV-04', read('fixtures/ev/EV-04.json'));
    expect(await verifyDecisions(client)).toEqual({ checked: 3, failures: [] });
  });

  it('EV-05: facts entered with each acceptance decide the claim, and every one is attributed to its version', async () => {
    const label = await play('E-EV-05', read('fixtures/ev/EV-05.json'));
    const { rows } = await client.query('SELECT "factId", "documentVersionId" FROM "ClaimFact" WHERE "claimId" = $1', ['E-EV-05']);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => label.has(r.documentVersionId))).toBe(true);
    expect((await verifyDecisions(client)).failures).toEqual([]);
  });

  it('a version\'s facts stop counting when a later upload supersedes it, and its id leaves the relied-on list', async () => {
    const fx = read('fixtures/ev/EV-04.json');
    await play('E-SUP', { ...fx, events: fx.events.slice(0, 3) });
    const v1 = (await readEvidence(client, 'E-SUP'));
    expect([v1.documentVersions.length, v1.facts['claim.coveredRepairCents']]).toEqual([1, 30000]);
    await upload('E-SUP', 'repairEstimate', 2);
    expect(await readEvidence(client, 'E-SUP')).toMatchObject({ documentVersions: [], facts: {} });
  });

  it('a fact no document carries is entered by a named person, the latest entry wins, and a changed fact is a changed input', async () => {
    const fx = read('fixtures/ev/EV-04.json');
    await play('E-STAFF', { ...fx, events: fx.events.slice(0, 1) });
    const first = await adjudicateClaim(client, 'E-STAFF', '2025-09-17');
    await enterFact(client, { claimId: 'E-STAFF', factId: 'claim.accountChanged', value: true, userId: STAFF });
    await enterFact(client, { claimId: 'E-STAFF', factId: 'claim.accountChanged', value: false, userId: STAFF });
    expect((await readEvidence(client, 'E-STAFF')).facts).toEqual({ 'claim.accountChanged': false });
    const second = await decision((await adjudicateClaim(client, 'E-STAFF', '2025-09-17')).decisionId);
    expect([second.supersedesId, second.facts['claim.accountChanged'], second.explanation.decision.reasons.includes('F10')]).toEqual([first.decisionId, false, false]);
    const audit = (await client.query(`SELECT "actorUserId", "data" FROM "AuditEvent" WHERE "targetId" = 'E-STAFF' AND "action" = 'fact.entered' ORDER BY "id"`)).rows;
    // The audit log is append-only and is not emptied between runs, so only this run's two events are read.
    expect(audit.slice(-2).map((a) => [a.actorUserId, a.data.factId, a.data.value])).toEqual([[STAFF, 'claim.accountChanged', true], [STAFF, 'claim.accountChanged', false]]);
  });

  it('refuses a fact the dictionary does not let a person enter, a value of the wrong type, and facts on a rejection', async () => {
    const fx = read('fixtures/ev/EV-04.json');
    await play('E-BAD', { ...fx, events: fx.events.slice(0, 1) });
    const enter = (factId: string, value: unknown) => enterFact(client, { claimId: 'E-BAD', factId, value, userId: STAFF });
    await expect(enter('claim.noSuchFact', true)).rejects.toThrow(/not a fact/);
    await expect(enter('docs.repairEstimate', 'accepted')).rejects.toThrow(/not a fact/);
    await expect(enter('contract.planCode', 'plus')).rejects.toThrow(/not a fact/);
    await expect(enter('claim.coveredRepairCents', 300.5)).rejects.toThrow(/cents/);
    await expect(enter('claim.accountChanged', 'no')).rejects.toThrow(/bool/);
    await expect(enter('evidence.proofOfPurchaseDate', '15/01/2025')).rejects.toThrow(/date/);
    const v = await upload('E-BAD', 'repairEstimate');
    await expect(reviewDocument(client, { versionId: v.versionId, result: 'rejected', reason: 'illegible', userId: null, facts: { 'claim.coveredRepairCents': 1 } })).rejects.toThrow(/rejected/);
    await expect(accept(v.versionId, { 'claim.coveredRepairCents': '300' })).rejects.toThrow(/cents/);
    expect((await client.query('SELECT count(*)::int AS n FROM "ClaimFact"')).rows[0].n).toBe(0);
  });

  it('the database refuses an unattributed fact, a null value, and any update or delete', async () => {
    const fx = read('fixtures/ev/EV-04.json');
    await play('E-DB', { ...fx, events: fx.events.slice(0, 1) });
    const insert = (value: string, by: string | null) => client.query(
      `INSERT INTO "ClaimFact" ("id", "claimId", "factId", "value", "enteredBy") VALUES (gen_random_uuid(), 'E-DB', 'claim.accountChanged', $1::jsonb, $2::uuid)`, [value, by]);
    await expect(insert('false', null)).rejects.toMatchObject({ constraint: 'claim_fact_attributed' });
    await expect(insert('null', STAFF)).rejects.toMatchObject({ constraint: 'claim_fact_value' });
    await insert('false', STAFF);
    await expect(client.query(`UPDATE "ClaimFact" SET "value" = 'true'`)).rejects.toMatchObject({ constraint: 'document_append_only' });
    await expect(client.query('DELETE FROM "ClaimFact"')).rejects.toMatchObject({ constraint: 'document_append_only' });
  });
});
