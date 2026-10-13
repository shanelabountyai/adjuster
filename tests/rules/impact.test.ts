import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { impactDiff, unhitRows } from '@/rules/impact';
import { validateDictionary } from '@/rules/validate';
import { applyEdits } from '../helpers/edits';

// Task 4.4 (D71). ID-01..04: a draft over the 13 golden decisions. `before` is each golden fixture's frozen decision,
// never the engine's; the draft stands in for the version of its kind, the other version stays as the fixture names it.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
const rs = (name: string) => read(`rules/electronics/${name}.json`);
const casesOf = (claims: string[]) => claims.map((id) => {
  const gc = read(`fixtures/gc/${id}.json`);
  return { claim: id, snapshot: gc.facts, asOf: gc.asOf, plan: rs(gc.plan), ops: rs(gc.ops), trace: { decision: gc.expected } };
});

describe('ID-01..04: the impact diff', () => {
  for (const n of [1, 2, 3, 4]) {
    const fx = read(`fixtures/id/ID-0${n}.json`);
    it(`${fx.id} ${fx.title}`, () => {
      expect(impactDiff(applyEdits(rs(fx.base), fx.edits), dict!, casesOf(fx.claims))).toEqual(fx.expected);
    });
  }

  it('a claim moves on its reasons alone, and an unedited draft moves nothing', () => {
    const cases = casesOf(['GC-05']);
    expect(impactDiff(rs('ops-v1'), dict!, cases)).toEqual({ changed: [], unchanged: 1 });
    const stored = [{ ...cases[0]!, trace: { decision: { ...cases[0]!.trace.decision, reasons: ['E22', 'E23'] } } }];
    expect(impactDiff(rs('ops-v1'), dict!, stored).changed.map((c) => [c.before.reasons, c.after.reasons])).toEqual([[['E22', 'E23'], ['E23']]]);
  });
});

describe('the coverage report', () => {
  it('lists the rows of a rule set that no trace hit, by rule', () => {
    const ops = rs('ops-v1');
    const traces = [{ rules: [{ ruleId: 'E23', rowIds: ['E23.pass'] }] }];
    const unhit = unhitRows(ops, traces);
    expect(unhit).toContainEqual({ ruleId: 'E23', rowId: 'E23.fail' });
    expect(unhit).not.toContainEqual({ ruleId: 'E23', rowId: 'E23.pass' });
    expect(unhitRows(ops, []).length).toBe(ops.rules.flatMap((r: { rows: unknown[] }) => r.rows).length);
  });
});
