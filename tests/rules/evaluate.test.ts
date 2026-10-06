import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evalCell, evalLookup, evalRow, evalRule, rootsOf, type Facts } from '@/rules/evaluate';
import { validateDictionary } from '@/rules/validate';
import type { Cell } from '@/rules/schema';

// Phase 1 task 1.7: three-valued condition evaluator against the frozen fixtures. RE-11/RE-12 are in schema.test.ts.
type Row = Parameters<typeof evalRule>[0][number];
type Fx = { title: string; cell?: Cell; when: Cell[]; cases: { cell?: Cell; rule: { rows: Row[] }; facts: Facts; expected: never }[] };
const json = (p: string): Fx => JSON.parse(readFileSync(p, 'utf8'));
const re = (n: number) => `RE-${String(n).padStart(2, '0')}`;

describe('RE-01..RE-10, RE-19, RE-21: one cell', () => {
  for (const id of [...Array.from({ length: 10 }, (_, i) => re(i + 1)), 'RE-19', 'RE-21']) {
    const fx = json(`fixtures/re/${id}.json`);
    fx.cases.forEach((c, i) =>
      it(`${id} #${i + 1} ${fx.title}`, () => expect(evalCell((c.cell ?? fx.cell)!, c.facts)).toBe(c.expected)));
  }
});

describe('RE-20: row AND', () => {
  const fx = json('fixtures/re/RE-20.json');
  fx.cases.forEach((c, i) => it(`#${i + 1}`, () => expect(evalRow(fx.when, c.facts)).toBe(c.expected)));
});

describe('RE-22: rule result', () => {
  const fx = json('fixtures/re/RE-22.json');
  fx.cases.forEach((c, i) => it(`#${i + 1}`, () => expect(evalRule(c.rule.rows, c.facts)).toEqual(c.expected)));
});

describe('RE-23: no row matches is a gap', () => {
  const fx = json('fixtures/re/RE-23.json');
  fx.cases.forEach((c, i) => it(`#${i + 1}`, () => expect(evalRule(c.rule.rows, c.facts)).toEqual(c.expected)));
});

describe('unique lookups and missing roots (1.8)', () => {
  const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
  const roots = rootsOf(dict!);
  const table = (id: string) => read('rules/electronics/plan-v1.json').lookups.find((l: { id: string }) => l.id === id).rows;

  it('exactly one TRUE row gives its value', () =>
    expect(evalLookup(table('deductibleCents'), { 'contract.planCode': 'premier', 'claim.peril': 'adh' }))
      .toEqual({ result: 'HIT', value: 9900, hits: ['ded.premier.adh'], missing: [] }));
  it('a TRUE row decides even when other rows are UNKNOWN', () =>
    expect(evalLookup(table('deductibleCents'), { 'contract.planCode': 'plus' }).value).toBe(7500));
  it('no TRUE row and all FALSE is a gap (Premier battery has no deductible)', () =>
    expect(evalLookup(table('deductibleCents'), { 'contract.planCode': 'premier', 'claim.peril': 'battery_degradation' }).result).toBe('GAP'));
  it('a derived fact that is missing pends on its input roots', () =>
    expect(evalLookup(table('retentionBps'), { 'contract.planCode': 'plus' }, roots))
      .toEqual({ result: 'PEND', value: null, hits: [], missing: ['claim.dateOfLoss', 'product.purchaseDate'] }));
  it('roots: input and lookup facts are their own root; derived facts recurse', () => {
    expect(roots('claim.peril')).toEqual(['claim.peril']);
    expect(roots('d.estimateVsLimitBps')).toEqual(['claim.coveredRepairCents', 'lookup.perClaimLimitCents']);
  });
  it('evalRule names roots too', () => {
    const rows = [{ id: 'r', when: [{ fact: 'd.daysSinceStart', op: 'gte' as const, value: 0 }], then: { outcome: 'PASS' as const } }];
    expect(evalRule(rows, {}, roots).missing).toEqual(['claim.dateOfLoss', 'contract.termStart']);
  });
  it('an UNKNOWN row with no root left to name still pends: unknown is never a gap', () => {
    const rows = [{ id: 'r', when: [{ fact: 'd.daysSinceStart', op: 'gte' as const, value: 0 }], then: { outcome: 'PASS' as const } }];
    expect(evalRule(rows, {}, () => [])).toEqual({ result: 'PEND', hits: [], missing: [] });
  });
  it('two TRUE rows means an unvalidated table: throw', () => {
    const rows = [{ id: 'a', when: [], value: 1 }, { id: 'b', when: [], value: 2 }];
    expect(() => evalLookup(rows, {})).toThrow('a, b');
  });
});

describe('beyond the fixtures', () => {
  it('null is UNKNOWN, same as absent', () => {
    expect(evalCell({ fact: 'claim.peril', op: 'neq', value: 'adh' }, { 'claim.peril': null })).toBe('UNKNOWN');
    expect(evalCell({ fact: 'claim.peril', op: 'is_known' }, { 'claim.peril': null })).toBe('FALSE');
  });
  it('false is a known value', () => {
    expect(evalCell({ fact: 'claim.cosmeticOnly', op: 'eq', value: false }, { 'claim.cosmeticOnly': false })).toBe('TRUE');
  });
  it('all rows FALSE is a rule gap, not a pass', () => {
    const rows = [{ id: 'r', when: [{ fact: 'claim.peril', op: 'eq' as const, value: 'adh' }], then: { outcome: 'PASS' as const } }];
    expect(evalRule(rows, { 'claim.peril': 'breakdown' })).toEqual({ result: 'GAP', hits: [], missing: [] });
  });
});
