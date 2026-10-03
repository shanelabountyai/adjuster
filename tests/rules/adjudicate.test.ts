import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adjudicate } from '@/rules/adjudicate';
import { sha256Hex } from '@/rules/canonical';
import { traceSchema } from '@/rules/schema';
import { validateDictionary } from '@/rules/validate';

// GC-01..GC-10: a full fact snapshot through the engine, compared with the frozen decision fixtures. Rules compare by
// ruleId (fixtures/README.md); rowIds, factsRead and prose are the engine's own output, checked against the schema.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
const plan = read('rules/electronics/plan-v1.json');
const ops = read('rules/electronics/ops-v1.json');

describe('GC-01..GC-10: golden claims', () => {
  for (let n = 1; n <= 10; n++) {
    const fx = read(`fixtures/gc/GC-${String(n).padStart(2, '0')}.json`);
    it(`${fx.id} ${fx.title}`, () => {
      const t = traceSchema.parse(adjudicate({ plan, ops, dict: dict!, snapshot: fx.facts, asOf: fx.asOf }));
      const e = fx.expected;
      expect(t.decision).toEqual({ outcome: e.outcome, reasons: e.reasons, payableCents: e.payableCents, contractFulfilled: e.contractFulfilled });
      expect(t.skipped).toEqual(e.skippedStages);
      expect(t.valuation).toEqual(e.valuation);
      const byId = (rs: { ruleId: string }[]) => [...rs].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      expect(byId(t.rules.map(({ ruleId, result, missing }) => ({ ruleId, result, missing })))).toEqual(byId(e.rules));
    });
  }

  it('PAY-H: a denial carries a null amount and no valuation (GC-02)', () => {
    const fx = read('fixtures/gc/GC-02.json');
    const t = adjudicate({ plan, ops, dict: dict!, snapshot: fx.facts, asOf: fx.asOf });
    expect([t.decision.outcome, t.decision.payableCents, t.valuation]).toEqual(['DENY', null, null]);
  });

  it('trace v1 is self-contained: hashed versions, resolved placeholders, visibility (D34)', () => {
    const fx = read('fixtures/gc/GC-04.json');
    const t = adjudicate({ plan, ops, dict: dict!, snapshot: fx.facts, asOf: fx.asOf });
    expect(t.versions).toEqual({ plan: { name: 'plan-v1', hash: sha256Hex(plan), effectiveFrom: plan.effectiveFrom },
      ops: { name: 'ops-v1', hash: sha256Hex(ops), effectiveFrom: ops.effectiveFrom } });
    const e2 = t.rules.find((r) => r.ruleId === 'E2')!;
    expect(e2.vars).toEqual({ start: fx.facts['contract.termStart'], end: fx.facts['contract.termEnd'], dol: fx.facts['claim.dateOfLoss'] });
    expect([e2.claimantVisible, e2.clause]).toEqual([true, '§2.1']);
  });

  it('a rule gap refers, never approves', () => {
    const fx = read('fixtures/gc/GC-01.json');
    const gapped = { ...plan, rules: plan.rules.map((r: { id: string; rows: { then: object }[] }) =>
      r.id === 'E1' ? { ...r, rows: [{ id: 'E1.never', when: [{ fact: 'claim.peril', op: 'eq', value: 'nothing' }], then: { outcome: 'PASS' } }] } : r) };
    const t = adjudicate({ plan: gapped, ops, dict: dict!, snapshot: fx.facts, asOf: fx.asOf });
    expect(t.decision.outcome).toBe('REFER');
    expect(t.decision.reasons).toEqual(['E1']);
    expect(t.rules.find((r) => r.ruleId === 'E1')!.reasonCode).toBe('RULE_GAP');
  });
});
