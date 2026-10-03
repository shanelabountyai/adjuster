import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import plan from '../../rules/electronics/plan-v1.json';
import ops from '../../rules/electronics/ops-v1.json';
import { sha256Hex } from '@/rules/canonical';

// Task 1.10: VP-01 and PL-04 hold at the database. Raw SQL on its own connection, so nothing in src/ can
// catch a case first. Each rejection is read from the error's constraint field.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "Decision", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
});

/** The constraint the database refused `sql` with, or 'accepted'. */
const run = async (sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
    return 'accepted';
  } catch (e) {
    return (e as { constraint?: string }).constraint ?? String(e);
  }
};

const insertVersion = async (body: { kind: string; product: string; version: number; effectiveFrom: string }, status = 'published') => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "RuleSetVersion" ("id", "kind", "product", "version", "status", "effectiveFrom", "body", "contentHash", "publishedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING "id"`,
    [body.kind, body.product, body.version, status, body.effectiveFrom, body, status === 'draft' ? null : sha256Hex(body), status === 'draft' ? null : '2026-01-01T00:00:00Z'],
  );
  return rows[0]!.id;
};

const h = 'a'.repeat(64);
const trace = { schema: 'adjuster.trace/1', rules: [{ ruleId: 'E1' }] };
const insertDecision = (planId: string, opsId: string, over: Record<string, unknown> = {}) => {
  const d = { outcome: 'APPROVE', payableCents: 1000, explanation: trace, overridesId: null, overrideReasonCode: null, overrideReasonText: null, ...over };
  return run(
    `INSERT INTO "Decision" ("id", "claimId", "planVersionId", "planHash", "opsVersionId", "opsHash", "asOf", "facts", "inputHash", "outputHash",
       "engineSemanticsVersion", "outcome", "payableCents", "explanation", "overridesId", "overrideReasonCode", "overrideReasonText")
     VALUES (gen_random_uuid(), 'C-1', $1, $2, $3, $2, '2026-06-01', '{}', $2, $2, '1', $4, $5, $6, $7, $8, $9)`,
    [planId, h, opsId, d.outcome, d.payableCents, d.explanation, d.overridesId, d.overrideReasonCode, d.overrideReasonText],
  );
};

describe('VP-01 published rule sets are immutable', () => {
  it('rejects UPDATE and DELETE of a published version, allows only retiring it', async () => {
    const id = await insertVersion(plan);
    expect(await run(`UPDATE "RuleSetVersion" SET "body" = '{}' WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'draft' WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'retired', "contentHash" = $2 WHERE "id" = $1`, [id, h])).toBe('ruleset_immutable');
    expect(await run(`DELETE FROM "RuleSetVersion" WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'retired' WHERE "id" = $1`, [id])).toBe('accepted');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'published' WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
    expect(await run(`DELETE FROM "RuleSetVersion" WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
  });

  it('leaves a draft editable, and publishing needs a hash', async () => {
    const id = await insertVersion(plan, 'draft');
    expect(await run(`UPDATE "RuleSetVersion" SET "body" = '{}' WHERE "id" = $1`, [id])).toBe('accepted');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'published', "publishedAt" = now() WHERE "id" = $1`, [id])).toBe('ruleset_published_hashed');
    expect(await run(`UPDATE "RuleSetVersion" SET "status" = 'published', "publishedAt" = now(), "contentHash" = $2 WHERE "id" = $1`, [id, h])).toBe('accepted');
    expect(await run(`UPDATE "RuleSetVersion" SET "body" = '{}' WHERE "id" = $1`, [id])).toBe('ruleset_immutable');
  });
});

describe('Decision rows', () => {
  let planId: string, opsId: string;
  beforeEach(async () => {
    planId = await insertVersion(plan);
    opsId = await insertVersion(ops);
  });

  it('PL-04: an insert without a non-empty trace fails', async () => {
    expect(await insertDecision(planId, opsId, { explanation: null })).toMatch(/null value in column "explanation"/);
    for (const explanation of [{}, { rules: [] }, { rules: {} }, [], null])
      expect(await insertDecision(planId, opsId, { explanation: JSON.stringify(explanation) })).toBe('decision_explanation');
    expect(await insertDecision(planId, opsId)).toBe('accepted');
  });

  it('is append-only', async () => {
    await insertDecision(planId, opsId);
    expect(await run(`UPDATE "Decision" SET "payableCents" = 1`)).toBe('decision_append_only');
    expect(await run(`DELETE FROM "Decision"`)).toBe('decision_append_only');
  });

  it('pins only published versions of the right kind', async () => {
    const draft = await insertVersion({ ...plan, version: 99 }, 'draft');
    expect(await insertDecision(draft, opsId)).toBe('decision_pins_published');
    expect(await insertDecision(opsId, opsId)).toBe('decision_pins_published');
    expect(await insertDecision(planId, planId)).toBe('decision_pins_published');
  });

  it('D14: denied has no amount; D18: an override carries its reasons', async () => {
    expect(await insertDecision(planId, opsId, { outcome: 'DENY', payableCents: 0 })).toBe('decision_denied_no_amount');
    expect(await insertDecision(planId, opsId, { outcome: 'DENY', payableCents: null })).toBe('accepted');
    expect(await insertDecision(planId, opsId, { payableCents: -1 })).toBe('decision_amount_non_negative');
    expect(await insertDecision(planId, opsId, { overrideReasonCode: 'X' })).toBe('decision_override_reason');
  });
});
