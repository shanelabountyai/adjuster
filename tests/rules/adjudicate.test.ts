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
const rs = (name: string) => read(`rules/electronics/${name}.json`);
const plan = rs('plan-v1');
const ops = rs('ops-v1');
type Fx = { plan: string; ops: string; facts: Parameters<typeof adjudicate>[0]['snapshot']; asOf: string; expected: Record<string, unknown> & { rules: { ruleId: string }[] } };
const run = (fx: Fx) => traceSchema.parse(adjudicate({ plan: rs(fx.plan), ops: rs(fx.ops), dict: dict!, snapshot: fx.facts, asOf: fx.asOf }));

describe('GC-01..GC-10, GC-12..GC-14 and RV-01: golden claims under the versions each fixture names', () => {
  const rv = read('fixtures/rv/RV-01.json');
  const cases: (Fx & { name: string })[] = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map((n) => {
      const fx = read(`fixtures/gc/GC-${String(n).padStart(2, '0')}.json`);
      return { ...fx, name: `${fx.id} ${fx.title}` };
    }),
    ...rv.cases.map((c: Fx & { contract: string }) => ({ ...c, name: `RV-01 ${c.contract}` })),
  ];
  for (const fx of cases) {
    it(fx.name, () => {
      const t = run(fx);
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
    const t = run(fx);
    const ops2 = rs('ops-v2');
    expect(t.versions).toEqual({ plan: { name: 'plan-v1', hash: sha256Hex(plan), effectiveFrom: plan.effectiveFrom, selectedBy: 'contract_pin' },
      ops: { name: 'ops-v2', hash: sha256Hex(ops2), effectiveFrom: ops2.effectiveFrom, selectedBy: 'latest_effective_on_asOf' } });
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
