import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { publishRuleSet, verifyDecisions } from '@/adjudication/decisions';
import { LocalDiskDocumentStore } from '@/adjudication/documents';
import { adjudicateClaim, overrideDecision } from '@/adjudication/pipeline';
import { fileClaim } from '../../scripts/seed-decisions';
import { seedOverrideReasons, staffAt } from '../helpers/tiers';

// Task 3.8 (D48, D59). A person signs off a referral: a second decision row beside the engine's, which stays as written.
// Out of authority writes nothing. GC-05's sign-off is the fixture; GC-12 is the referral that carries flags.

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

const store = new LocalDiskDocumentStore(join(tmpdir(), 'adjuster-pipeline-docs'));
const versionIds: Record<string, string> = {};
let staff: Record<'system' | 'adjuster', string>;
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "TierAssignment", "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versionIds[name] = await publishRuleSet(client, read(`rules/electronics/${name}.json`));
  await seedOverrideReasons(client);
  staff = await staffAt(client, ['system', 'adjuster']);
});

const gc = (n: string) => read(`fixtures/gc/GC-${n}.json`);
const gc05 = gc('05');
const so = gc05.signoff;
/** Files a golden claim and adjudicates it; returns the engine decision's id. */
const decide = async (id: string, fx: { plan: string; asOf: string; facts: Record<string, unknown> }) => {
  await fileClaim(client, store, versionIds[fx.plan], { id, facts: fx.facts });
  return (await adjudicateClaim(client, id, fx.asOf)).decisionId!;
};
const row = async (id: string) => (await client.query('SELECT *, "asOf"::text AS "asOf" FROM "Decision" WHERE "id" = $1', [id])).rows[0];
const state = async (id: string) => [
  (await client.query('SELECT "status" FROM "Claim" WHERE "id" = $1', [id])).rows[0].status,
  Number((await client.query('SELECT count(*) FROM "Decision" WHERE "claimId" = $1', [id])).rows[0].count)];
const signOff = (claimId: string, over: Record<string, unknown> = {}) =>
  overrideDecision(client, { claimId, userId: staff.adjuster, reasonCode: so.reasonCode, reasonText: so.reasonText, asOf: so.asOf, ...over });
const tamper = async (sql: string, params: unknown[] = []) => {
  await client.query('ALTER TABLE "Decision" DISABLE TRIGGER USER');
  try { await client.query(sql, params); } finally { await client.query('ALTER TABLE "Decision" ENABLE TRIGGER USER'); }
};
const codes = async () => [...new Set((await verifyDecisions(client)).failures.map((f) => f.code))];

describe('overrideDecision', () => {
  it('GC-05: an adjuster signs off the referral at 77500; the engine decision stays as written and verify is OK', async () => {
    const engineId = await decide('O-GC-05', gc05);
    const engine = await row(engineId);
    expect([engine.outcome, engine.payableCents]).toEqual(['REFER', so.amountCents]);

    const r = await signOff('O-GC-05', { userId: staff[so.by as 'adjuster'] });
    const o = await row(r.decisionId);
    expect([o.outcome, o.payableCents, o.overridesId, o.overrideTier, o.overrideTotalIncurredCents, o.asOf, o.opsVersionId, o.overrideReasonCode, o.overrideReasonText, o.overrideBy])
      .toEqual([so.expected.outcome, so.expected.payableCents, engineId, so.by, so.expected.authority.totalIncurredCents, so.asOf, versionIds[so.expected.ops], so.reasonCode, so.reasonText, staff.adjuster]);
    expect([o.explanation, o.inputHash, o.outputHash, o.supersedesId]).toEqual([engine.explanation, engine.inputHash, engine.outputHash, null]);
    expect(await row(engineId)).toEqual(engine);
    expect([r.claimStatus, ...(await state('O-GC-05'))]).toEqual([so.expected.claimStatus, so.expected.claimStatus, 2]);
    expect(await verifyDecisions(client)).toEqual({ checked: 2, failures: [] });
  });

  it('out of authority is refused before anything is written: the amount, no tier at all, and the power to clear a flag', async () => {
    await decide('O-amount', gc05);
    await expect(signOff('O-amount', { userId: staff.system })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['amount'] });
    await expect(signOff('O-amount', { userId: '00000000-0000-4000-8000-000000000009' })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', tier: null });
    await expect(signOff('O-amount', { userId: null })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY' });
    expect(await state('O-amount')).toEqual(['REFERRED', 1]);

    // GC-12 refers on F1 and F3 at 37500: inside the system tier's limit, so only the power is lacking
    const flagged = gc('12');
    await decide('O-flag', flagged);
    const at = { asOf: flagged.asOf, reasonCode: 'FLAG_CLEARED' };
    await expect(signOff('O-flag', { ...at, userId: staff.system })).rejects.toMatchObject({ code: 'OUT_OF_AUTHORITY', lacks: ['power'] });
    expect(await state('O-flag')).toEqual(['REFERRED', 1]);
    await signOff('O-flag', at);
    expect(await state('O-flag')).toEqual(['DECIDED', 2]);
    expect(await codes()).toEqual([]);
  });

  it('only the current referral, with an amount, a listed reason code and a reason, on or after its own date', async () => {
    await decide('O-approved', gc('01'));
    await expect(signOff('O-approved')).rejects.toThrow('NOT_OVERRIDABLE');
    expect(await state('O-approved')).toEqual(['DECIDED', 1]);

    await decide('O-refused', gc05);
    await expect(signOff('O-refused', { reasonCode: 'GOODWILL' })).rejects.toMatchObject({ constraint: 'Decision_overrideReasonCode_fkey' });
    await expect(signOff('O-refused', { reasonText: '  ' })).rejects.toMatchObject({ constraint: 'decision_override_text' });
    await expect(signOff('O-refused', { asOf: '2025-09-17' })).rejects.toThrow('NOT_OVERRIDABLE');
    expect(await state('O-refused')).toEqual(['REFERRED', 1]);
    await signOff('O-refused');
    await expect(signOff('O-refused')).rejects.toThrow('NOT_OVERRIDABLE'); // already signed off
    expect(await state('O-refused')).toEqual(['DECIDED', 2]);
  });

  it('a later engine decision supersedes the referral, and the override of it is no longer the claim\'s decision', async () => {
    await decide('O-again', gc05);
    await signOff('O-again');
    // DECIDED leaves only through payment (3.9) and a reopen (3.10); the status is set below the service to get there (D38)
    await client.query(`UPDATE "Claim" SET "status" = 'REOPENED' WHERE "id" = 'O-again'`);
    const r = await adjudicateClaim(client, 'O-again', '2025-09-25');
    expect([r.decisionId && r.outcome, ...(await state('O-again'))]).toEqual(['REFER', 'REFERRED', 3]);
    expect(await codes()).toEqual([]);
    await signOff('O-again', { asOf: '2025-09-26' });
    expect(await state('O-again')).toEqual(['DECIDED', 4]);
    expect(await codes()).toEqual([]);
  });
});

describe('decisions:verify on an override row', () => {
  it('OVERRIDE_UNAUTHORIZED: a tier that does not hold the limit, a total written down, or a tier without the power', async () => {
    await decide('O-v1', gc05);
    const { decisionId } = await signOff('O-v1');
    await tamper(`UPDATE "Decision" SET "overrideTier" = 'system' WHERE "id" = $1`, [decisionId]);
    expect(await codes()).toEqual(['OVERRIDE_UNAUTHORIZED']);
    await tamper(`UPDATE "Decision" SET "overrideTotalIncurredCents" = 1 WHERE "id" = $1`, [decisionId]); // the amount is still 77500
    expect(await codes()).toEqual(['OVERRIDE_UNAUTHORIZED']);
    await tamper(`UPDATE "Decision" SET "overrideTier" = 'adjuster', "overrideTotalIncurredCents" = 100001 WHERE "id" = $1`, [decisionId]);
    expect(await codes()).toEqual(['OVERRIDE_UNAUTHORIZED']);
    await tamper(`UPDATE "Decision" SET "overrideTotalIncurredCents" = 100000 WHERE "id" = $1`, [decisionId]);
    expect(await codes()).toEqual([]);

    const flagged = gc('12');
    await decide('O-v2', flagged);
    const f = await signOff('O-v2', { asOf: flagged.asOf, reasonCode: 'FLAG_CLEARED' });
    await tamper(`UPDATE "Decision" SET "overrideTier" = 'system' WHERE "id" = $1`, [f.decisionId]);
    expect(await codes()).toEqual(['OVERRIDE_UNAUTHORIZED']);
  });

  it('OVERRIDE_INVALID: the facts the engine decided on, changed on the override row, or an override dated before its decision', async () => {
    await decide('O-v3', gc05);
    const { decisionId } = await signOff('O-v3');
    await tamper(`UPDATE "Decision" SET "facts" = "facts" || '{"claim.peril": "theft"}' WHERE "id" = $1`, [decisionId]);
    expect(await codes()).toEqual(['OVERRIDE_INVALID']);
    await tamper(`UPDATE "Decision" SET "facts" = (SELECT "facts" FROM "Decision" WHERE "id" = $2), "asOf" = '2025-09-17' WHERE "id" = $1`, [decisionId, (await row(decisionId)).overridesId]);
    expect(await codes()).toEqual(['OVERRIDE_INVALID']);
    // an amount the engine never calculated, still inside the adjuster's limit
    await tamper(`UPDATE "Decision" SET "asOf" = $2, "payableCents" = 90000 WHERE "id" = $1`, [decisionId, so.asOf]);
    expect(await codes()).toEqual(['OVERRIDE_INVALID']);
  });
});
