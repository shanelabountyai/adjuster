import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evalCell, evalRow, evalRule, type Facts } from '@/rules/evaluate';
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
