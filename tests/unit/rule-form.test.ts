import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyForm } from '@/app/o/[org]/rules/[id]/form';
import { FACT_TYPES, OPERATORS, ruleSetSchema, type Dictionary, type RuleSet } from '@/rules/schema';
import { operatorsFor, validateDictionary, validateRuleSet } from '@/rules/validate';

// Task 4.10: the editor's operator select and its form-to-body step.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const plan = ruleSetSchema.parse(read('rules/electronics/plan-v2.json')) as RuleSet;
const ops = ruleSetSchema.parse(read('rules/electronics/ops-v3.json')) as RuleSet;
const dict = validateDictionary(read('rules/electronics/facts-v1.json')).dict!;
const body = (b: Record<string, unknown>) => b as unknown as RuleSet;

describe('operatorsFor', () => {
  // One fact per type, each operator with a value it fits: the select offers exactly what the validator calls defined.
  it('offers an operator for a type iff the validator does not call it undefined there', () => {
    for (const type of FACT_TYPES) {
      const d: Dictionary = { schema: 'adjuster.facts/1', id: 't', product: 't', facts: [{ id: 't.f', type, source: 'input', ...(type === 'enum' ? { values: ['a'] } : {}) }] };
      for (const op of OPERATORS) {
        const rs = { ...plan, rules: [{ ...plan.rules[0]!, rows: [{ id: 'r', when: [{ fact: 't.f', op }], then: { outcome: 'PASS' as const } }] }], lookups: [], payout: undefined };
        const undefinedHere = validateRuleSet(rs, d).some((i) => /not defined for|only feed derived facts/.test(i.message));
        expect([type, op, operatorsFor(type).includes(op)]).toEqual([type, op, !undefinedHere]);
      }
    }
  });
});

describe('applyForm', () => {
  it('types a cell value by its fact and operator, and a lookup value by the one it replaces', () => {
    const b = body(applyForm(plan, dict, {
      'lookups.0.rows.0.value': '12500',
      'rules.2.rows.1.when.1.op': 'between', 'rules.2.rows.1.when.1.value': '7, 30',
      'rules.2.rows.1.when.0.op': 'is_known', 'rules.2.rows.1.when.0.value': 'premier',
    }));
    expect(b.lookups![0]!.rows[0]!.value).toBe(12500);
    expect(b.rules[2]!.rows[1]!.when[1]).toEqual({ fact: 'd.daysSinceStart', op: 'between', value: [7, 30] });
    expect(b.rules[2]!.rows[1]!.when[0]).toEqual({ fact: 'contract.planCode', op: 'is_known' });
    expect(plan.lookups![0]!.rows[0]!.value).toBe(10000); // the stored body is not touched
  });

  it('ignores a path D72 does not open, and a number that is not an integer', () => {
    const b = body(applyForm(plan, dict, { 'rules.0.id': 'E99', 'rules.0.stage': 'decision', 'payout.steps.0.op': 'cap_at', 'version': '9', 'lookups.0.rows.0.value': '1.5', '__proto__.x': 'y' }));
    expect(b).toEqual(plan);
  });

  it('adds a row under a fresh id and a condition, and keeps a table its last row', () => {
    let b = body(applyForm(plan, dict, { _do: 'add:lookups.0.rows' }));
    expect(b.lookups![0]!.rows.at(-1)!.id).toBe(`${plan.lookups![0]!.rows.at(-1)!.id}.1`);
    b = body(applyForm(plan, dict, { _do: 'add:rules.0.rows.0.when' }));
    expect(b.rules[0]!.rows[0]!.when).toHaveLength(plan.rules[0]!.rows[0]!.when.length + 1);
    const one = { ...plan, rules: [{ ...plan.rules[0]!, rows: [plan.rules[0]!.rows[0]!] }, ...plan.rules.slice(1)] };
    expect(body(applyForm(one, dict, { _do: 'remove:rules.0.rows.0' })).rules[0]!.rows).toHaveLength(1);
    expect(body(applyForm(plan, dict, { _do: 'remove:rules.2.rows.1' })).rules[2]!.rows).toHaveLength(plan.rules[2]!.rows.length - 1);
  });

  it('edits the ops parameters: a blank limit is no limit, powers are a list, a template can be cleared', () => {
    const i = ops.authority!.findIndex((a) => a.approveUpToCents !== null);
    const b = body(applyForm(ops, dict, {
      [`authority.${i}.approveUpToCents`]: '', [`authority.${i}.powers`]: 'ex_gratia, publish_rules',
      'reminders.closeDay': '45', 'outcomePolicy.autoDenyEnabled': 'false',
    }));
    expect(b.authority![i]).toMatchObject({ approveUpToCents: null, powers: ['ex_gratia', 'publish_rules'] });
    expect(b.reminders!.closeDay).toBe(45);
    expect(b.outcomePolicy!.autoDenyEnabled).toBe(false);
    const row = plan.rules.findIndex((r) => r.rows.some((x) => x.then.noteText));
    const ri = plan.rules[row]!.rows.findIndex((x) => x.then.noteText);
    expect(body(applyForm(plan, dict, { [`rules.${row}.rows.${ri}.then.noteText`]: ' ' })).rules[row]!.rows[ri]!.then).not.toHaveProperty('noteText');
  });
});
