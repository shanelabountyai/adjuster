import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { publishRuleSet, verifyDecisions } from '@/adjudication/decisions';
import { enterFact, LocalDiskDocumentStore, readDocumentStatuses, readEvidence, reviewDocument } from '@/adjudication/documents';
import { readReminderLevel, runNoResponse } from '@/adjudication/no-response';
import { transitionClaim } from '@/adjudication/claim-status';
import { mockPaymentProvider, paidCents } from '@/adjudication/payments';
import { renderDecision } from '@/adjudication/letters';
import { acceptEvidence, adjudicateClaim, openClaim, overrideDecision, payClaim, reopenClaim, uploadEvidence, waiveEvidence } from '@/adjudication/pipeline';
import { fileClaim } from '../../scripts/seed-decisions';
import { seedOverrideReasons, staffAt } from '../helpers/tiers';

// Task 3.4 (D47, D55): a fact is a row someone entered, from a document version or on their own word. The snapshot
// reads those rows, a document's facts count only while its version is accepted, and the decision names the versions.
// Task 3.5 (D51a, D51d, D51f, D56): filing, accepting and waiving decide the claim themselves; an upload does not.
// Task 3.6 (D51h, D51i, D57): the no-response job reminds and closes on the injected date, and an upload reopens.
// Task 3.9 (D50, D51j, D60): paying sends what the claim has not been paid of its current decision's amount, and closes it.
// Every event is checked against the fixture: both statuses, cents paid, documents, reminder level, the decision and what each rule that did not pass is missing.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
let store: LocalDiskDocumentStore;
const versionIds: Record<string, string> = {};
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
  await seedOverrideReasons(client);
  const root = await mkdtemp(join(tmpdir(), 'adjuster-facts-'));
  store = new LocalDiskDocumentStore(root);
  return () => rm(root, { recursive: true });
});

const STAFF = '00000000-0000-4000-8000-000000000001';
const onContract = ([k]: [string, unknown]) => k.startsWith('contract.') || k.startsWith('product.');
const upload = (claimId: string, type: string, n = 1) =>
  uploadEvidence(client, store, { claimId, type, bytes: new TextEncoder().encode(`${claimId} ${type} ${n}`), source: 'claimant', uploadedBy: null });
const accept = (versionId: string, facts?: Record<string, unknown>) => reviewDocument(client, { versionId, result: 'accepted', userId: null, facts });
const decision = async (id: string | null) => (await client.query('SELECT * FROM "Decision" WHERE "id" = $1', [id])).rows[0];

type Action = { type: string; facts: Record<string, unknown>; doc: string; version: string; by: string; reasonText: string; reasonCode: string; reason: string };
type NotPassed = { ruleId: string; result: string; missing: string[] };
type Expected = { row: number; kind: string; outcome: string; payableCents: number | null; reasons: string[]; notPassed: NotPassed[]; documentVersions: string[]; supersedes: number | null;
  overrides: number; totalIncurredCents: number };
type Life = { plan: string; events: { asOf: string; action: Action; expected: { claimStatus: string; paymentStatus: string; paidCents: number; paymentCents?: number; reminderLevel: number; docs: Record<string, string>; decisionRows: number; decision: Expected } }[] };

/**
 * Plays a claim life's events through the services and returns the label of each version id. `before` runs ahead of
 * each event.
 */
async function play(id: string, fx: Life, before?: (a: Action) => Promise<unknown>) {
  const label = new Map<string, string>();
  const idOf = (l: string) => [...label].find(([, v]) => v === l)![0];
  for (const [i, { asOf, action: a, expected: e }] of fx.events.entries()) {
    await before?.(a);
    if (a.type === 'open') {
      const facts = Object.entries(a.facts);
      await client.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${id}`, versionIds[fx.plan], Object.fromEntries(facts.filter(onContract))]);
      await openClaim(client, { id, contractId: `CT-${id}`, facts: Object.fromEntries(facts.filter((f) => !onContract(f))) as never }, asOf);
    } else if (a.type === 'upload') label.set((await upload(id, a.doc, i)).versionId, a.version);
    else if (a.type === 'accept') await acceptEvidence(client, { versionId: idOf(a.version), facts: a.facts, userId: null }, asOf);
    else if (a.type === 'waive') await waiveEvidence(client, { claimId: id, type: a.doc, reasonText: a.reasonText, asOf, userId: (await staffAt(client, [a.by]))[a.by] ?? null });
    else if (a.type === 'tick') await runNoResponse(client, asOf);
    else if (a.type === 'override') await overrideDecision(client, { claimId: id, userId: (await staffAt(client, [a.by]))[a.by]!, reasonCode: a.reasonCode, reasonText: a.reasonText, asOf });
    else if (a.type === 'pay') expect([i, (await payClaim(client, mockPaymentProvider, { claimId: id, asOf, userId: null })).paymentCents]).toEqual([i, e.paymentCents]);
    else if (a.type === 'reopen') await reopenClaim(client, { claimId: id, userId: (await staffAt(client, ['adjuster'])).adjuster, reason: a.reason });
    else throw new Error(`play: ${a.type}`);

    const rows = (await client.query('SELECT * FROM "Decision" WHERE "claimId" = $1 ORDER BY "createdAt"', [id])).rows;
    const d = rows[e.decision.row];
    const { status, paymentStatus } = (await client.query('SELECT "status", "paymentStatus" FROM "Claim" WHERE "id" = $1', [id])).rows[0];
    expect([i, status, paymentStatus, await paidCents(client, id), await readReminderLevel(client, id), (await readDocumentStatuses(client, id)).docs])
      .toEqual([i, e.claimStatus, e.paymentStatus, e.paidCents, e.reminderLevel, e.docs]);
    if (e.decision.kind === 'override') {
      expect([i, rows.length, d.outcome, d.payableCents, d.overridesId, d.overrideTier, d.overrideTotalIncurredCents])
        .toEqual([i, e.decisionRows, e.decision.outcome, e.decision.payableCents, rows[e.decision.overrides].id, a.type === 'override' ? a.by : d.overrideTier, e.decision.totalIncurredCents]);
      continue;
    }
    expect([i, rows.length, d.outcome, d.payableCents, d.explanation.decision.reasons, d.documentVersions.map((v: string) => label.get(v)).sort()])
      .toEqual([i, e.decisionRows, e.decision.outcome, e.decision.payableCents, e.decision.reasons, e.decision.documentVersions]);
    expect([i, d.supersedesId]).toEqual([i, e.decision.supersedes === null ? null : rows[e.decision.supersedes].id]);
    const notPassed = (d.explanation.rules as NotPassed[]).filter((r) => r.result !== 'PASS').map(({ ruleId, result, missing }) => ({ ruleId, result, missing }));
    expect([i, notPassed]).toEqual([i, e.decision.notPassed]);
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

});

const gc15: Life = read('fixtures/gc/GC-15.json');
const gc15To = (type: string) => ({ ...gc15, events: gc15.events.slice(0, gc15.events.findIndex((e) => e.action.type === type) + 1) });
const pay = (claimId: string, asOf: string, provider = mockPaymentProvider) => payClaim(client, provider, { claimId, asOf, userId: null });
const payments = async () => (await client.query('SELECT "amountCents", "asOf"::text AS "asOf" FROM "Payment" ORDER BY "createdAt"')).rows;
const statuses = async (id: string) => Object.values((await client.query('SELECT "status", "paymentStatus" FROM "Claim" WHERE "id" = $1', [id])).rows[0]);

describe('payment', () => {
  it('GC-15: 85100 is paid, the supplemental pays the 85000 not yet paid, and authority is tested on what is already paid', async () => {
    const staff = await staffAt(client, ['system', 'adjuster']);
    await play('E-GC-15', gc15, async (a) => {
      // 85100 paid is incurred whatever is being approved (D50): a waiver approving nothing, then OV-02's 170100 total
      if (a.type === 'accept' && a.version === 'repairEstimate/2')
        await expect(waiveEvidence(client, { claimId: 'E-GC-15', type: 'repairEstimate', reasonText: 'x', asOf: '2025-09-10', userId: staff.system }))
          .rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['amount', 'power'] });
      if (a.type === 'override' && a.by === 'senior')
        await expect(overrideDecision(client, { claimId: 'E-GC-15', userId: staff.adjuster, reasonCode: a.reasonCode, reasonText: a.reasonText, asOf: '2025-09-11' }))
          .rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['amount'] });
    });
    expect(await payments()).toEqual([{ amountCents: 85100, asOf: '2025-08-21' }, { amountCents: 85000, asOf: '2025-09-12' }]);
    expect((await verifyDecisions(client)).failures).toEqual([]);

    // paying twice is a no-op, and a payment made is never edited or removed
    expect(await pay('E-GC-15', '2025-09-13')).toEqual({ paymentCents: 0, claimStatus: 'CLOSED' });
    expect(await payments()).toHaveLength(2);
    await expect(client.query('UPDATE "Payment" SET "amountCents" = 1')).rejects.toMatchObject({ constraint: 'document_append_only' });
    await expect(client.query('DELETE FROM "Payment"')).rejects.toMatchObject({ constraint: 'document_append_only' });
  });

  it('a denial and an approval at 0 never pay; a referral nobody signed off cannot be paid', async () => {
    await play('E-EV-02', read('fixtures/ev/EV-02.json'));
    expect(await pay('E-EV-02', '2025-09-18')).toEqual({ paymentCents: 0, claimStatus: 'DECIDED' });

    const zero = read('fixtures/gc/GC-06.json');
    await fileClaim(client, store, versionIds[zero.plan], { id: 'E-GC-06', facts: zero.facts });
    expect(await adjudicateClaim(client, 'E-GC-06', zero.asOf)).toMatchObject({ outcome: 'APPROVE', claimStatus: 'DECIDED' });
    expect(await pay('E-GC-06', zero.asOf)).toEqual({ paymentCents: 0, claimStatus: 'DECIDED' });

    await play('E-REFER', gc15To('waive'));
    await expect(pay('E-REFER', '2025-08-20')).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    expect([await statuses('E-REFER'), await payments()]).toEqual([['REFERRED', 'NONE'], []]);
  });

  it('a provider that fails leaves the claim decided and unpaid, and a payment is never dated before its decision', async () => {
    await play('E-FAIL', gc15To('override'));
    await expect(pay('E-FAIL', '2025-08-21', { pay: () => Promise.reject(new Error('provider down')) })).rejects.toThrow('provider down');
    await expect(pay('E-FAIL', '2025-08-19')).rejects.toThrow('before its decision');
    expect([await statuses('E-FAIL'), await payments()]).toEqual([['DECIDED', 'NONE'], []]);
    expect(await pay('E-FAIL', '2025-08-21')).toEqual({ paymentCents: 85100, claimStatus: 'CLOSED' });
    expect(await statuses('E-FAIL')).toEqual(['CLOSED', 'PAID']);
  });

  it('a recomputed total below what was paid: the paid money stays incurred, nothing more goes out, and the claim may close (D61)', async () => {
    const { adjuster } = await staffAt(client, ['adjuster']);
    await play('E-LOWER', gc15To('pay'));
    await reopenClaim(client, { claimId: 'E-LOWER', userId: adjuster, reason: 'supplemental' });
    const again = gc15.events.find((e) => e.action.version === 'repairEstimate/2' && e.action.type === 'accept')!.action;
    const { versionId } = await upload('E-LOWER', 'repairEstimate', 2);
    const engine = await acceptEvidence(client, { versionId, facts: { ...again.facts, 'claim.coveredRepairCents': 60000 }, userId: null }, '2025-09-10');
    const o = await overrideDecision(client, { claimId: 'E-LOWER', userId: adjuster, reasonCode: 'FLAG_CLEARED', reasonText: 'x', asOf: '2025-09-11' });
    const [e, d] = [await decision(engine.decisionId), await decision(o.decisionId)];
    expect([e.outcome, e.payableCents < 85100, d.payableCents, d.overrideTotalIncurredCents]).toEqual(['REFER', true, e.payableCents, 85100]);
    expect(await pay('E-LOWER', '2025-09-12')).toEqual({ paymentCents: 0, claimStatus: 'DECIDED' });
    expect([await payments(), (await verifyDecisions(client)).failures]).toEqual([[{ amountCents: 85100, asOf: '2025-08-21' }], []]);
    await expect(transitionClaim(client, 'E-LOWER', 'PAYMENT_PENDING', { userId: null })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    await transitionClaim(client, 'E-LOWER', 'CLOSED', { userId: adjuster });
    expect([await statuses('E-LOWER'), await paidCents(client, 'E-LOWER')]).toEqual([['CLOSED', 'PAID'], 85100]);
  });
});

describe('supplemental (task 3.10, D61)', () => {
  const reopened = () => client.query(`SELECT "actorUserId", "data" FROM "AuditEvent" WHERE "targetId" = 'E-GC-15' AND "data"->>'to' = 'REOPENED'`);

  it('a reopen needs a closed claim, a tier and a reason, and writes the reason on the audit event', async () => {
    const { adjuster } = await staffAt(client, ['adjuster']);
    const before = (await reopened()).rows.length; // the audit log is never emptied
    await play('E-GC-15', gc15To('override')); // DECIDED, not yet paid
    await expect(reopenClaim(client, { claimId: 'E-GC-15', userId: adjuster, reason: 'supplemental' })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    await pay('E-GC-15', '2025-08-21');
    await expect(reopenClaim(client, { claimId: 'E-GC-15', userId: null, reason: 'supplemental' })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['tier'] });
    await expect(reopenClaim(client, { claimId: 'E-GC-15', userId: adjuster, reason: ' ' })).rejects.toThrow(/REASON_REQUIRED/);
    expect([await statuses('E-GC-15'), (await reopened()).rows.length]).toEqual([['CLOSED', 'PAID'], before]);

    expect(await reopenClaim(client, { claimId: 'E-GC-15', userId: adjuster, reason: 'teardown found more damage' })).toEqual({ claimStatus: 'REOPENED' });
    const { rows } = await reopened();
    expect([rows.length, rows.at(-1).actorUserId, rows.at(-1).data.reason]).toEqual([before + 1, adjuster, 'teardown found more damage']);
    await expect(reopenClaim(client, { claimId: 'E-GC-15', userId: adjuster, reason: 'again' })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
  });
});

describe('no response', () => {
  it('GC-11: reminders on day 10 and 20, closed on day 30 with no decision written, reopened by the upload and decided on its acceptance', async () => {
    await play('E-GC-11', read('fixtures/gc/GC-11.json'));
    const outcomes = (await client.query(`SELECT "outcome" FROM "Decision" WHERE "claimId" = 'E-GC-11' ORDER BY "createdAt"`)).rows.map((r) => r.outcome);
    expect(outcomes).toEqual(['PEND', 'PEND', 'PEND', 'PEND', 'APPROVE']);
    expect((await verifyDecisions(client)).failures).toEqual([]);
  });

  it('one run sends at most one reminder, a second run the same day sends none, and the day before the first reminder sends none', async () => {
    const fx = read('fixtures/ev/EV-04.json');
    await play('E-LATE', { ...fx, events: fx.events.slice(0, 1) }); // pends on 2025-09-17
    expect(await runNoResponse(client, '2025-09-26')).toEqual({ reminded: [], closed: [], skipped: [] });
    expect(await runNoResponse(client, '2025-10-07')).toEqual({ reminded: [{ claimId: 'E-LATE', level: 2 }], closed: [], skipped: [] });
    expect(await runNoResponse(client, '2025-10-07')).toEqual({ reminded: [], closed: [], skipped: [] });
    expect((await client.query('SELECT "level" FROM "ClaimReminder"')).rows).toEqual([{ level: 2 }]);
    await expect(client.query('UPDATE "ClaimReminder" SET "level" = 1')).rejects.toMatchObject({ constraint: 'document_append_only' });
  });

  it('a new PEND starts the count again, and a claim reopened by an upload can pend and be closed again', async () => {
    const fx: Life = read('fixtures/gc/GC-11.json');
    await play('E-AGAIN', { ...fx, events: fx.events.slice(0, 2) }); // FNOL and an estimate uploaded on 2025-09-17
    await runNoResponse(client, '2025-09-27');
    const versionId = (await client.query<{ id: string }>('SELECT "id" FROM "DocumentVersion"')).rows[0]!.id;
    await acceptEvidence(client, { versionId, facts: fx.events[2]!.action.facts, userId: null }, '2025-10-01');
    expect(await readReminderLevel(client, 'E-AGAIN')).toBe(0);
    expect(await runNoResponse(client, '2025-10-17')).toMatchObject({ reminded: [{ claimId: 'E-AGAIN', level: 1 }], closed: [] }); // day 30 of the first PEND, 16 of this one
    expect(await runNoResponse(client, '2025-10-31')).toMatchObject({ closed: ['E-AGAIN'] });
    // closed for no response is reopened by its upload, never by the supplemental's reopen (D61 a)
    await expect(reopenClaim(client, { claimId: 'E-AGAIN', userId: (await staffAt(client, ['adjuster'])).adjuster, reason: 'supplemental' })).rejects.toMatchObject({ code: 'ILLEGAL_TRANSITION' });
    const late = await upload('E-AGAIN', 'damagePhotos');
    expect((await client.query(`SELECT "status" FROM "Claim" WHERE "id" = 'E-AGAIN'`)).rows[0].status).toBe('REOPENED');
    await acceptEvidence(client, { versionId: late.versionId, userId: null }, '2025-11-03');
    expect(await runNoResponse(client, '2026-01-01')).toMatchObject({ closed: ['E-AGAIN'] });
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

// Task 3.11 (D62): the letter and note of each stored row, read back by id alone.
describe('letters and notes from stored rows', () => {
  it('GC-15 up to its sign-off: documents, the waiver, the referral and the override each say what the rows hold', async () => {
    await play('E-GC-15', gc15To('override'));
    const rows = (await client.query('SELECT "id", "outcome", "documentVersions", "overridesId", "overrideBy" FROM "Decision" WHERE "claimId" = $1 ORDER BY "createdAt"', ['E-GC-15'])).rows;
    const [first, refer, over] = [rows[0], rows.at(-2), rows.at(-1)];
    const event = (type: string) => gc15.events.find((e) => e.action.type === type)!;
    const [waive, signed] = [event('waive'), event('override')];

    const fnol = await renderDecision(client, first.id);
    expect(fnol.letter).toContain('(1) We need: proof of purchase. (§8.1)');
    expect(fnol.letter.trimEnd().split('\n').at(-1)).toBe('Please send us what is listed above. We will decide your claim when we have it.');
    expect(fnol.note).toContain(`Decided by the engine (adjuster.engine/7), decision ${first.id}; no person.`);
    expect(fnol.note).toContain('Documents relied on: none.');

    const referral = await renderDecision(client, refer.id);
    expect([refer.outcome, refer.documentVersions.length]).toEqual(['REFER', 4]);
    const relied = (await client.query('SELECT v."id", v."sha256", v."version", d."type" FROM "DocumentVersion" v JOIN "Document" d ON d."id" = v."documentId" WHERE v."id"::text = ANY($1)', [refer.documentVersions])).rows;
    for (const v of relied) expect(referral.note).toContain(`Document relied on: ${v.type} version ${v.version}, id ${v.id}, sha256 ${v.sha256}.`);
    expect(referral.note).toMatch(new RegExp(`Document waived: secondEstimate, by user [0-9a-f-]{36} at tier ${waive.action.by} on ${waive.asOf}: `));
    expect(referral.note).toContain(waive.action.reasonText);
    expect(referral.note).toContain('Calculated payable cents: 85100, not approved.');
    expect(referral.note).toContain('Facts as decided:\nclaim.accountChanged=false\n');
    expect(referral.note).toContain('\nclaim.coveredRepairCents=95000\n'); // the row's snapshot, not the claim's later facts
    expect(referral.note).toContain('\ndocs.secondEstimate=waived\n');
    expect(referral.letter).toBe(`Decision as of ${waive.asOf}: Your claim needs review by an adjuster. No decision has been made yet.\n`);
    expect(fnol.note).not.toContain('Document waived'); // the first decision did not rely on a waiver made later

    const override = await renderDecision(client, over.id);
    expect(override.note.split('\n').slice(0, 3)).toEqual([
      `APPROVE by override as of ${signed.asOf}. Payable cents: 85100. Decision ${over.id} overrides decision ${refer.id}.`,
      expect.stringMatching(new RegExp(`^Decided by user ${over.overrideBy} at tier ${signed.action.by}, tested on total incurred 85100 cents under ops rules sha256 [0-9a-f]{64}\\.$`)),
      `Override reason ${signed.action.reasonCode}: ${signed.action.reasonText}`,
    ]);
    expect(override.note).toContain(waive.action.reasonText);
    expect(override.letter.split('\n')[0]).toBe(`Decision as of ${signed.asOf}: Approved.`);
    expect(override.letter).toContain('Amount payable: $851.00.');
    for (const hidden of [signed.action.reasonText, signed.action.reasonCode, waive.action.reasonText, over.overrideBy, 'F2', 'tier', 'review'])
      expect(override.letter).not.toContain(hidden);
    await expect(renderDecision(client, '00000000-0000-4000-8000-000000000000')).rejects.toThrow('no decision');
  });
});
