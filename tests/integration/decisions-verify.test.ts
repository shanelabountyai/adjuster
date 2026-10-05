import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { publishRuleSet, verifyDecisions } from '@/adjudication/decisions';
import { sha256Hex } from '@/rules/canonical';
import { seedDecisions } from '../../scripts/seed-decisions';

// Task 1.11. The clean seed (GC-01..GC-10 decided) verifies; each tamper TM-01..TM-08, written below the service with
// raw SQL and the immutability triggers switched off, fails with exactly its one code. TM-09 is task 2.8's (D41).

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());

let ids: Record<string, string> = {};
let opsId = '';
beforeEach(async () => {
  await connected;
  ({ decisions: ids, opsId } = await seedDecisions(client));
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
    expect(await verifyDecisions(client)).toEqual({ checked: 10, failures: [] });
    expect((await verifyDecisions(client, '2025-07-18')).checked).toBe(2); // --as-of: GC-03 and GC-08
  });

  it('TM-01 a published rule-set body edited in place → RULESET_HASH_MISMATCH', async () => {
    await tamper(`UPDATE "RuleSetVersion" SET "body" = jsonb_set("body", '{rules,0,name}', '"tampered"') WHERE "id" = $1`, [opsId]);
    expect(await codes()).toEqual(['RULESET_HASH_MISMATCH']);
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
    await copyOf(ids['GC-01']!, JSON.stringify({ overridesId: ids['GC-02'], overrideReasonCode: 'GOODWILL', overrideReasonText: 'tamper' }));
    expect(await codes()).toEqual(['OVERRIDE_INVALID']);
  });

  it('TM-08 a decision stamped with semantics this engine lacks → SEMANTICS_UNSUPPORTED', async () => {
    await tamper(`UPDATE "Decision" SET "engineSemanticsVersion" = 'adjuster.engine/0' WHERE "id" = $1`, [ids['GC-01']]);
    expect(await codes()).toEqual(['SEMANTICS_UNSUPPORTED']);
  });

  it('TM-09 a contract re-pinned to another plan version under its decision → VERSION_NOT_EFFECTIVE', async () => {
    const v2 = await publishRuleSet(client, JSON.parse(readFileSync('rules/electronics/plan-v2.json', 'utf8')));
    expect(await codes()).toEqual([]); // publishing alone breaks nothing
    await tamper(`UPDATE "Contract" SET "planVersionId" = $1 WHERE "id" = 'CT-GC-04'`, [v2]); // GC-04's asOf is after plan-v2's date
    expect(await codes()).toEqual(['VERSION_NOT_EFFECTIVE']);
  });
});
