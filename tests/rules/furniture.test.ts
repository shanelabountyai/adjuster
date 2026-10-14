import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adjudicate } from '@/rules/adjudicate';
import { valuate } from '@/rules/calc';
import { resolveFacts } from '@/rules/derive';
import { renderLetter } from '@/rules/render';
import { calcStepTraceSchema, traceSchema } from '@/rules/schema';
import { checkDictionaryHash, validateDictionary, validateRuleSet } from '@/rules/validate';

// Task 4.8, CP-01: the second product is rule data only. The same engine, validator and letters as electronics, pointed
// at rules/furniture and the frozen fixtures that name it (D85). Nothing here is furniture's own code: there is none.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const dictFile = read('rules/furniture/facts-v1.json');
const { dict, issues } = validateDictionary(dictFile);
const rs = (name: string) => read(`rules/furniture/${name}.json`);
const plan = rs('plan-v1');
const of = (dir: string, prefix: string) => readdirSync(`fixtures/${dir}`).filter((f) => f.startsWith(prefix)).sort().map((f) => read(`fixtures/${dir}/${f}`));
const run = (fx: { plan: string; ops: string; facts: Parameters<typeof adjudicate>[0]['snapshot']; asOf: string }) =>
  traceSchema.parse(adjudicate({ plan: rs(fx.plan), ops: rs(fx.ops), dict: dict!, snapshot: fx.facts, asOf: fx.asOf }));

describe('furniture rule data', () => {
  it('the dictionary, plan-v1 and ops-v1 validate clean and are bound to the dictionary by hash', () => {
    expect(issues).toEqual([]);
    for (const name of ['plan-v1', 'ops-v1']) expect([...validateRuleSet(rs(name), dict!), ...checkDictionaryHash(rs(name), dictFile)]).toEqual([]);
  });

  it('D86: the brief’s first ids, H1 and HF1, are refused by the validator; E101 and F101 are not', () => {
    const withId = (id: string) => ({ ...rs('ops-v1'), rules: [{ ...rs('ops-v1').rules[0], id }] });
    expect(['H1', 'HF1', 'E101', 'F101'].map((id) => validateRuleSet(withId(id), dict!).map((i) => `${i.code} ${i.path}`))).toEqual([['SCHEMA rules.0.id'], ['SCHEMA rules.0.id'], [], []]);
  });
});

describe('FG-01..FG-12: furniture’s golden claims through the engine', () => {
  const goldens = of('gc', 'FG-');
  it('there are twelve, each naming its product', () => expect(goldens.map((g) => g.product)).toEqual(Array(12).fill('furniture')));
  for (const fx of goldens) {
    it(`${fx.id} ${fx.title}`, () => {
      const t = run(fx);
      const e = fx.expected;
      expect(t.decision).toEqual({ outcome: e.outcome, reasons: e.reasons, payableCents: e.payableCents, contractFulfilled: e.contractFulfilled });
      expect(t.skipped).toEqual(e.skippedStages);
      expect(t.valuation && { path: t.valuation.path, steps: t.valuation.steps }).toEqual(e.valuation); // labels are prose, not frozen (D42)
      const byId = (rules: { ruleId: string }[]) => [...rules].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
      expect(byId(t.rules.map(({ ruleId, result, missing }) => ({ ruleId, result, missing })))).toEqual(byId(e.rules));
      expect(t.rules.filter((r) => r.result === 'GAP')).toEqual([]);
    });
  }

  it('D80: a replacement’s letter says store credit, a repair’s does not; the amount is the same kind of number either way', () => {
    const [replaced, repaired] = ['FG-08', 'FG-01'].map((id) => renderLetter(run(goldens.find((g) => g.id === id))));
    expect(replaced).toContain('store credit');
    expect(repaired).not.toContain('store credit');
  });

  it('FP-H: a denial carries a null amount and no valuation (FG-02)', () => {
    const ref = read('fixtures/pay/FP-H.json');
    const t = run(goldens.find((g) => g.id === ref.ref));
    expect({ payableCents: t.decision.payableCents, valuation: t.valuation, outcome: t.decision.outcome }).toEqual(ref.expected);
  });
});

describe('FP: furniture’s plan-v1 payout over the fixture facts', () => {
  for (const fx of of('pay', 'FP-').filter((f) => f.kind === 'valuation')) {
    it(`${fx.id} ${fx.title}`, () => {
      const { calc, ...v } = valuate(plan, resolveFacts(fx.facts, dict!, plan));
      expect(v).toEqual(fx.expected);
      expect(calc['calc.payableCents']).toBe(v.payableCents);
      for (const s of fx.expected.steps) expect(calcStepTraceSchema.safeParse(s).success).toBe(true);
    });
  }
});

describe('RE-24, RE-25: a derived and a lookup fact resolved from inputs', () => {
  for (const id of ['RE-24', 'RE-25']) {
    const fx = read(`fixtures/re/${id}.json`);
    it(`${id} ${fx.title}`, () => {
      expect(fx.cases.map((c: { facts: Parameters<typeof resolveFacts>[0] }) => resolveFacts(c.facts, dict!, rs(fx.plan))[fx.fact] ?? null))
        .toEqual(fx.cases.map((c: { expected: unknown }) => c.expected));
    });
  }
});
