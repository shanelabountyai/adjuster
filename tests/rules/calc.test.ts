import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSteps, valuate } from '@/rules/calc';
import { resolveFacts } from '@/rules/derive';
import { divHalfUp } from '@/rules/money';
import { validateDictionary } from '@/rules/validate';

// Phase 1 task 1.9: calc steps (RE-13..RE-18) and plan-v1 payout (PAY-A..PAY-I). PAY-H is a denial (GC-02): it is
// checked by the decision pipeline, since valuation never runs for it.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
const plan = read('rules/electronics/plan-v1.json');

describe('RE-13..RE-18: one calc step each', () => {
  for (const n of [13, 14, 15, 16, 17, 18]) {
    const fx = read(`fixtures/re/RE-${n}.json`);
    it(`RE-${n} ${fx.title}`, () => expect(runSteps(fx.steps, fx.facts)).toEqual(fx.expected));
  }
});

describe('PAY: plan-v1 payout over the fixture facts', () => {
  for (const id of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'I']) {
    const fx = read(`fixtures/pay/PAY-${id}.json`);
    it(`PAY-${id} ${fx.title}`, () => {
      const { calc, ...v } = valuate(plan, resolveFacts(fx.facts, dict!, plan));
      expect(v).toEqual(fx.expected);
      expect(calc['calc.payableCents']).toBe(v.payableCents);
    });
  }
});

describe('divHalfUp: the one rounding rule', () => {
  it('rounds .5 away from zero, below .5 toward it', () => {
    expect([divHalfUp(5, 2), divHalfUp(4999, 10000), divHalfUp(5000, 10000), divHalfUp(-5, 2), divHalfUp(-4, 2)]).toEqual([3, 0, 1, -3, -2]);
  });
  it('refuses inputs past exact integer range rather than round silently', () => {
    expect(() => divHalfUp(2 ** 53, 1)).toThrow();
    expect(() => divHalfUp(1, 0)).toThrow();
  });
});

describe('beyond the fixtures', () => {
  it('an unknown operand is an error, not a zero: the pipeline must pend before valuation', () =>
    expect(() => runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { fact: 'claim.coveredRepairCents' } }], {})).toThrow('claim.coveredRepairCents'));
  it('a step on an unset register is an error', () =>
    expect(() => runSteps([{ id: 'a', op: 'subtract', reg: 'L', operand: { const: 1 } }], {})).toThrow('L'));
  it('derived facts: days, full years at the anniversary, rounded ratio, window counts', () => {
    const f = resolveFacts({
      'contract.termStart': '2024-02-29', 'claim.dateOfLoss': '2025-02-28', 'product.purchaseDate': '2024-02-28',
      'claim.peril': 'adh', 'claim.coveredRepairCents': 1, 'claim.replacementValueCents': 3,
      'history.priorClaims': [
        { claimId: 'p1', dateOfLoss: '2024-02-29', peril: 'adh', outcome: 'APPROVE', paidCents: 100 },
        { claimId: 'p2', dateOfLoss: '2025-02-21', peril: 'breakdown', outcome: 'DENY', paidCents: 0 },
      ],
    }, dict!, plan);
    expect(f['d.daysSinceStart']).toBe(365);
    expect(f['d.productAgeYears']).toBe(1);
    expect(f['d.repairRatioBps']).toBe(3333);
    expect([f['d.claims12mAdh'], f['d.claims60d'], f['d.dupWithin7'], f['d.sumPriorPaid']]).toEqual([1, 1, 0, 100]);
    expect(f['d.daysReportLag']).toBeNull(); // dateReported missing: UNKNOWN, not 0
  });
});
