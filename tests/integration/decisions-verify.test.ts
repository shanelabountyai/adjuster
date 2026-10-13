import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { publishRuleSet, verifyDecisions } from '@/adjudication/decisions';
import { createDraft, publishDraft, saveDraft } from '@/adjudication/drafts';
import { renderDecision } from '@/adjudication/letters';
import { sha256Hex } from '@/rules/canonical';
import { seedDecisions } from '../../scripts/seed-decisions';
import { staffAt } from '../helpers/tiers';

// Task 1.11, reseeded by 2.11 and 3.12. The clean seed (19 claims through the pipeline, four versions) verifies; each tamper TM-01..TM-08, written below the service with
// raw SQL and the immutability triggers switched off, fails with exactly its one code. TM-09 is task 2.8's (D41), OVERRIDE_UNAUTHORIZED is 3.8's (D48),
// APPEAL_UNAUTHORIZED is 4.5's (D75).

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

let ids: Record<string, string> = {};
let opsId = '';
let versions: Record<string, string> = {};
beforeEach(async () => {
  await connected;
  ({ decisions: ids, versions } = await seedDecisions(client));
  opsId = versions['ops-v1']!;
});

/** Runs `sql` with the immutability triggers off, as only someone below the service could. */
const tamper = async (sql: string, params: unknown[] = []) => {
  await client.query('ALTER TABLE "Decision" DISABLE TRIGGER USER; ALTER TABLE "RuleSetVersion" DISABLE TRIGGER USER; ALTER TABLE "Contract" DISABLE TRIGGER USER');
  try { await client.query(sql, params); } finally {
    await client.query('ALTER TABLE "Decision" ENABLE TRIGGER USER; ALTER TABLE "RuleSetVersion" ENABLE TRIGGER USER; ALTER TABLE "Contract" ENABLE TRIGGER USER');
  }
};
const codes = async () => [...new Set((await verifyDecisions(client)).failures.map((f) => f.code))];
const copyOf = (id: string, set: string) => tamper(
  `INSERT INTO "Decision" SELECT (jsonb_populate_record(NULL::"Decision", to_jsonb(d) || jsonb_build_object('id', gen_random_uuid(), 'createdAt', now()) || $2::jsonb)).*
   FROM "Decision" d WHERE "id" = $1`, [id, set]);

describe('decisions:verify', () => {
  it('reports OK on the clean seed', async () => {
    expect(await verifyDecisions(client)).toEqual({ checked: 54, failures: [] }); // 17 engine rows, GC-05's sign-off, GC-11's five, GC-15's nine and the 22 of AP-01..06
    expect((await verifyDecisions(client, '2025-07-18')).checked).toBe(3); // --as-of: GC-03, GC-08 and GC-12
  });

  it('the seed covers both plan versions and both sides of the ops-v2 date', async () => {
    const pinned = async (id: string) => {
      const { rows } = await client.query('SELECT "planVersionId", "opsVersionId", "payableCents" FROM "Decision" WHERE "id" = $1', [ids[id]]);
      return [Object.keys(versions).find((k) => versions[k] === rows[0].planVersionId), Object.keys(versions).find((k) => versions[k] === rows[0].opsVersionId), rows[0].payableCents];
    };
    expect(await pinned('OPS-v1-last-day')).toEqual(['plan-v1', 'ops-v1', 25000]);
    expect(await pinned('OPS-v2-first-day')).toEqual(['plan-v1', 'ops-v2', 25000]);
    expect(await pinned('RV-01-v1')).toEqual(['plan-v1', 'ops-v2', 25000]);
    expect(await pinned('RV-01-v2')).toEqual(['plan-v2', 'ops-v2', 20000]);
  });

  it('3.12 the seeded GC-15 is told from its stored rows: nine decisions, the supplemental signed off at 170100 by a senior adjuster, two payments, every move audited', async () => {
    const rows = (await client.query(`SELECT "id", "outcome" FROM "Decision" WHERE "claimId" = 'GC-15' ORDER BY "createdAt"`)).rows;
    expect(rows.map((r) => r.outcome)).toEqual(['PEND', 'PEND', 'PEND', 'PEND', 'PEND', 'REFER', 'APPROVE', 'REFER', 'APPROVE']);
    for (const r of rows) await renderDecision(client, r.id); // every row renders a letter and a note
    const last = await renderDecision(client, rows[8].id);
    expect(last.note.split('\n').slice(0, 3)).toEqual([
      `APPROVE by override as of 2025-09-11. Payable cents: 170100. Decision ${rows[8].id} overrides decision ${rows[7].id}.`,
      expect.stringMatching(/^Decided by user [0-9a-f-]{36} at tier senior, tested on total incurred 170100 cents under ops rules sha256 [0-9a-f]{64}\.$/),
      'Override reason FLAG_CLEARED: F2: unrelated failure, network-repaired; teardown estimate reviewed',
    ]);
    expect(last.letter).toContain('Amount payable: $1701.00.');
    // the seed does not empty AuditEvent, so an earlier seed's GC-15 is still there: this one's events name its decisions
    const events = (await client.query(`SELECT "action", "data" FROM "AuditEvent" WHERE "targetId" = 'GC-15' AND "data"->>'decisionId' = ANY($1) ORDER BY "id"`, [rows.map((r) => r.id)])).rows;
    expect(events.filter((e) => e.action === 'claim.paid').map((e) => [e.data.asOf, e.data.amountCents])).toEqual([['2025-08-21', 85100], ['2025-09-12', 85000]]);
    expect(events.filter((e) => e.data.to === 'REOPENED').map((e) => e.data.reason)).toEqual(['supplemental']);
    expect(events.at(-1)!.data).toMatchObject({ from: 'PAID', to: 'CLOSED', decisionId: rows[8].id });
  });

  it('D44 publish refuses an ops version a stored decision would select on replay, and takes a later one', async () => {
    const ops = JSON.parse(readFileSync('rules/electronics/ops-v2.json', 'utf8'));
    await expect(publishRuleSet(client, { ...ops, version: 4, effectiveFrom: '2026-03-31' })).rejects.toThrow('OPS_BACKDATED'); // OPS-v1-last-day
    await expect(publishRuleSet(client, { ...ops, version: 4, effectiveFrom: '2028-01-27' })).rejects.toThrow('OPS_BACKDATED'); // GC-04, the latest asOf, boundary inclusive
    await publishRuleSet(client, { ...ops, version: 4, effectiveFrom: '2028-01-28' });
    expect(await codes()).toEqual([]);
    // what the refusal prevents: the same version written below the service turns clean decisions red
    await tamper(`UPDATE "RuleSetVersion" SET "effectiveFrom" = '2026-03-31' WHERE "kind" = 'ops' AND "version" = 4`);
    expect(await codes()).toEqual(['VERSION_NOT_EFFECTIVE']);
  });

  it('4.3 a draft published from the screen meets the same D44 refusal, and a later one leaves verify clean', async () => {
    const ops = JSON.parse(readFileSync('rules/electronics/ops-v3.json', 'utf8'));
    const staff = await staffAt(client, ['senior', 'manager']);
    const asOf = ops.effectiveFrom; // the first day author_rules is in force
    const id = await createDraft(client, { kind: 'ops', product: ops.product, userId: staff.senior, asOf });
    const publish = async (effectiveFrom: string) => {
      await saveDraft(client, { id, userId: staff.senior, body: { ...ops, effectiveFrom }, asOf });
      const { rows } = await client.query('SELECT "body" FROM "RuleSetVersion" WHERE "id" = $1', [id]);
      return publishDraft(client, { id, userId: staff.manager, diffHash: sha256Hex(rows[0].body), asOf });
    };
    await expect(publish('2028-01-27')).rejects.toMatchObject({ code: 'OPS_BACKDATED' }); // GC-04, the latest asOf
    expect((await client.query('SELECT "status", "contentHash" FROM "RuleSetVersion" WHERE "id" = $1', [id])).rows[0]).toEqual({ status: 'draft', contentHash: null });
    await publish('2028-01-28');
    expect(await codes()).toEqual([]);
  });

  it('TM-01 a published rule-set body edited in place → RULESET_HASH_MISMATCH', async () => {
    await tamper(`UPDATE "RuleSetVersion" SET "body" = jsonb_set("body", '{rules,0,name}', '"tampered"') WHERE "id" = $1`, [opsId]);
    expect(await codes()).toEqual(['RULESET_HASH_MISMATCH']);
  });

  it('a relied-on document version removed from the row → FACTS_HASH_MISMATCH (D47)', async () => {
    await tamper(`UPDATE "Decision" SET "documentVersions" = "documentVersions"[2:] WHERE "id" = $1`, [ids['GC-01']]);
    expect(await codes()).toEqual(['FACTS_HASH_MISMATCH']);
  });

  it('TM-02 a stored fact changed → FACTS_HASH_MISMATCH', async () => {
    await tamper(`UPDATE "Decision" SET "facts" = jsonb_set("facts", '{claim.coveredRepairCents}', '99999') WHERE "id" = $1`, [ids['GC-01']]);
    expect(await codes()).toEqual(['FACTS_HASH_MISMATCH']);
  });

  it('TM-03 a denial rewritten as a self-consistent approval → REPLAY_DIVERGED', async () => {
    const { rows } = await client.query('SELECT "explanation" FROM "Decision" WHERE "id" = $1', [ids['GC-02']]);
    const forged = { ...rows[0].explanation, decision: { ...rows[0].explanation.decision, outcome: 'APPROVE', reasons: [], payableCents: 1000 } };
    await tamper(`UPDATE "Decision" SET "outcome" = 'APPROVE', "payableCents" = 1000, "explanation" = $2, "outputHash" = $3 WHERE "id" = $1`,
      [ids['GC-02'], forged, sha256Hex(forged)]);
    expect(await codes()).toEqual(['REPLAY_DIVERGED']);
  });

  it('TM-04 the amount column edited, the trace left alone → EXPLANATION_INCONSISTENT', async () => {
    await tamper(`UPDATE "Decision" SET "payableCents" = "payableCents" + 1 WHERE "id" = $1`, [ids['GC-01']]);
    expect(await codes()).toEqual(['EXPLANATION_INCONSISTENT']);
  });

  it('TM-05 the ops version made effective after the decisions it served → VERSION_NOT_EFFECTIVE', async () => {
    await tamper(`UPDATE "RuleSetVersion" SET "effectiveFrom" = '2030-01-01' WHERE "id" = $1`, [opsId]);
    expect(await codes()).toEqual(['VERSION_NOT_EFFECTIVE']);
  });

  it('TM-06 a second, unchained decision for the same claim → CHAIN_BROKEN', async () => {
    await copyOf(ids['GC-01']!, '{}');
    expect(await codes()).toEqual(['CHAIN_BROKEN']);
  });

  it('TM-07 an override pointing at another claim\'s decision → OVERRIDE_INVALID', async () => {
    await copyOf(ids['GC-01']!, JSON.stringify({ overridesId: ids['GC-02'], overrideReasonCode: 'SIGN_OFF', overrideReasonText: 'tamper', overrideTier: 'manager', overrideTotalIncurredCents: 0, overrideBy: '00000000-0000-4000-8000-000000000001' }));
    expect(await codes()).toEqual(['OVERRIDE_INVALID']);
  });

  it('a sign-off rewritten to a tier that does not hold its amount → OVERRIDE_UNAUTHORIZED (D48)', async () => {
    await tamper(`UPDATE "Decision" SET "overrideTier" = 'system' WHERE "id" = $1`, [ids['GC-05-signoff']]);
    expect(await codes()).toEqual(['OVERRIDE_UNAUTHORIZED']);
  });

  it('an appeal row rewritten to a tier without the power, or to the person who overrode on the claim → APPEAL_UNAUTHORIZED (D75)', async () => {
    const failed = async () => (await verifyDecisions(client)).failures.map((f) => [f.code, f.detail.includes('overrode')]);
    await tamper(`UPDATE "Decision" SET "appealTier" = 'adjuster' WHERE "claimId" = 'AP-01' AND "appealBy" IS NOT NULL`);
    expect(await failed()).toEqual([['APPEAL_UNAUTHORIZED', false]]);
    await tamper(`UPDATE "Decision" SET "appealTier" = 'senior' WHERE "claimId" = 'AP-01' AND "appealBy" IS NOT NULL`);
    await tamper(`UPDATE "Decision" SET "appealBy" = (SELECT "overrideBy" FROM "Decision" WHERE "claimId" = 'AP-03' AND "overrideBy" IS NOT NULL) WHERE "claimId" = 'AP-03' AND "appealBy" IS NOT NULL`);
    expect(await failed()).toEqual([['APPEAL_UNAUTHORIZED', true]]);
  });

  it('TM-08 a decision stamped with semantics this engine lacks → SEMANTICS_UNSUPPORTED', async () => {
    await tamper(`UPDATE "Decision" SET "engineSemanticsVersion" = 'adjuster.engine/0' WHERE "id" = $1`, [ids['GC-01']]);
    expect(await codes()).toEqual(['SEMANTICS_UNSUPPORTED']);
  });

  it('TM-09 a contract re-pinned to another plan version under its decision → VERSION_NOT_EFFECTIVE', async () => {
    await tamper(`UPDATE "Contract" SET "planVersionId" = $1 WHERE "id" = 'CT-GC-04'`, [versions['plan-v2']]); // GC-04's asOf is after plan-v2's date
    expect(await codes()).toEqual(['VERSION_NOT_EFFECTIVE']);
  });
});
