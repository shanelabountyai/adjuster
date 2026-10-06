import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import plan from '../../rules/electronics/plan-v1.json';
import ops from '../../rules/electronics/ops-v1.json';
import { IllegalTransitionError, transitionClaim } from '@/adjudication/claim-status';
import { sha256Hex } from '@/rules/canonical';

// Tasks 1.10 and 2.3: VP-01, PL-04 and the contract and claim rules hold at the database. Raw SQL on its own connection, so nothing in src/ can
// catch a case first. Each rejection is read from the error's constraint field.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
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
const insertContract = (id: string, planId: string) =>
  run(`INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, '{}')`, [id, planId]);
const insertClaim = (id: string, contractId: string, over: Record<string, unknown> = {}) =>
  run(`INSERT INTO "Claim" ("id", "contractId", "facts", "status", "paymentStatus") VALUES ($1, $2, '{}', $3, $4)`,
    [id, contractId, over.status ?? 'OPEN', over.paymentStatus ?? 'NONE']);

const insertDecision = (planId: string, opsId: string, over: Record<string, unknown> = {}) => {
  const d = { outcome: 'APPROVE', payableCents: 1000, explanation: trace, overridesId: null, overrideReasonCode: null, overrideReasonText: null, ...over };
  return run(
    `INSERT INTO "Decision" ("id", "claimId", "planVersionId", "planHash", "opsVersionId", "opsHash", "asOf", "facts", "inputHash", "outputHash",
       "engineSemanticsVersion", "outcome", "payableCents", "explanation", "overridesId", "overrideReasonCode", "overrideReasonText")
     VALUES (gen_random_uuid(), $10, $1, $2, $3, $2, '2026-06-01', '{}', $2, $2, '1', $4, $5, $6, $7, $8, $9)`,
    [planId, h, opsId, d.outcome, d.payableCents, d.explanation, d.overridesId, d.overrideReasonCode, d.overrideReasonText, over.claimId ?? 'C-1'],
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
    await insertClaim('C-1', 'CT-1');
  });

  it('belongs to a claim that exists', async () => {
    expect(await insertDecision(planId, opsId, { claimId: 'C-404' })).toBe('Decision_claimId_fkey');
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

describe('Contract and Claim rows (2.3, D36)', () => {
  let planId: string;
  beforeEach(async () => {
    planId = await insertVersion(plan);
  });

  it('a contract pins a published plan version, then is read-only', async () => {
    const draft = await insertVersion({ ...plan, version: 99 }, 'draft');
    expect(await insertContract('CT-1', draft)).toBe('contract_pins_plan');
    expect(await insertContract('CT-1', await insertVersion(ops))).toBe('contract_pins_plan');
    expect(await insertContract('CT-1', planId)).toBe('accepted');
    expect(await run(`UPDATE "Contract" SET "facts" = '{"contract.status": "cancelled"}'`)).toBe('contract_read_only');
    expect(await run(`DELETE FROM "Contract"`)).toBe('contract_read_only');
    expect(await run(`DELETE FROM "RuleSetVersion" WHERE "id" = $1`, [planId])).toBe('ruleset_immutable');
  });

  it('a claim may quote an unknown contract (PL-06 is the pipeline\'s call), and its two statuses are closed sets', async () => {
    expect(await insertClaim('C-1', 'CT-0404')).toBe('accepted');
    expect(await insertClaim('C-2', 'CT-1', { status: 'APPROVED' })).toBe('claim_status');
    expect(await insertClaim('C-2', 'CT-1', { paymentStatus: 'DECIDED' })).toBe('claim_payment_status');
    expect(await run(`UPDATE "Claim" SET "status" = 'IN_REVIEW', "paymentStatus" = 'PENDING' WHERE "id" = 'C-1'`)).toBe('accepted');
  });
});

describe('PL-01 claim transitions at the database (2.5, D38)', () => {
  const events = async (id: string) => (await client.query(
    `SELECT "actorUserId", "action", "data" FROM "AuditEvent" WHERE "targetType" = 'Claim' AND "targetId" = $1 ORDER BY "id"`, [id])).rows;
  const statusOf = async (id: string) => (await client.query(`SELECT "status" FROM "Claim" WHERE "id" = $1`, [id])).rows[0].status;
  const fresh = async (status = 'OPEN') => {
    const id = `C-${randomUUID()}`; // audit rows outlive the TRUNCATE above, so each test gets its own claim id
    await insertClaim(id, 'CT-1', { status });
    return id;
  };

  it('a legal move changes the status and appends one audit event', async () => {
    const id = await fresh();
    await transitionClaim(client, id, 'IN_REVIEW', { userId: null, reason: 'adjudication started' });
    expect(await statusOf(id)).toBe('IN_REVIEW');
    expect(await events(id)).toEqual([{ actorUserId: null, action: 'claim.status_changed',
      data: { from: 'OPEN', to: 'IN_REVIEW', decisionId: null, reason: 'adjudication started' } }]);
  });

  it('an illegal move throws and leaves no trace', async () => {
    const id = await fresh();
    await expect(transitionClaim(client, id, 'PAID', { userId: null })).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(transitionClaim(client, 'C-none', 'IN_REVIEW', { userId: null })).rejects.toThrow(/not found/);
    expect(await statusOf(id)).toBe('OPEN');
    expect(await events(id)).toEqual([]);
  });

  it('leaving DECIDED reads the current decision: a denial may close, a payable approval may not, no decision may do neither', async () => {
    const [planId, opsId] = [await insertVersion(plan), await insertVersion(ops)];
    const [denied, paid, none] = [await fresh('DECIDED'), await fresh('DECIDED'), await fresh('DECIDED')];
    expect(await insertDecision(planId, opsId, { claimId: denied, outcome: 'DENY', payableCents: null })).toBe('accepted');
    expect(await insertDecision(planId, opsId, { claimId: paid })).toBe('accepted');
    await transitionClaim(client, denied, 'CLOSED', { userId: null });
    expect(await statusOf(denied)).toBe('CLOSED');
    await expect(transitionClaim(client, paid, 'CLOSED', { userId: null })).rejects.toBeInstanceOf(IllegalTransitionError);
    await transitionClaim(client, paid, 'PAYMENT_PENDING', { userId: null });
    for (const to of ['CLOSED', 'PAYMENT_PENDING', 'UNDER_APPEAL'] as const)
      await expect(transitionClaim(client, none, to, { userId: null })).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('a claim moved by someone else between the check and the write is not moved again', async () => {
    const id = await fresh();
    const racing = { query: async (sql: string, params?: unknown[]) => {
      const r = await client.query(sql, params);
      if (sql.startsWith('SELECT')) await client.query(`UPDATE "Claim" SET "status" = 'WITHDRAWN' WHERE "id" = $1`, [id]);
      return r;
    } };
    await expect(transitionClaim(racing as never, id, 'IN_REVIEW', { userId: null })).rejects.toThrow(/left OPEN/);
    expect(await statusOf(id)).toBe('WITHDRAWN');
    expect(await events(id)).toEqual([]);
  });
});
