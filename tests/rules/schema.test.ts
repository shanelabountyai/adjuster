import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { calcStepTraceSchema, dictionarySchema, isIsoDate, ruleSetSchema, traceSchema } from '@/rules/schema';
import { validateDictionary, validateRuleSet } from '@/rules/validate';
import { applyEdits } from '../helpers/edits';

// Phase 1 task 1.3: the schemas and publish-time checks. Rule data and fixtures are read from disk, never built here.
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict, issues: dictIssues } = validateDictionary(json('rules/electronics/facts-v1.json'));
const plan = json('rules/electronics/plan-v1.json');
const ops = json('rules/electronics/ops-v1.json');
const codes = (rs: unknown) => [...new Set(validateRuleSet(rs, dict!).map((i) => i.code))].sort();
const minimal = (row: object) => ({ ...ops, rules: [{ ...ops.rules[0], rows: [row] }] });

describe('rule data', () => {
  it('the fact dictionary, plan-v1 and ops-v1 validate clean', () => {
    expect(dictIssues).toEqual([]);
    expect(validateRuleSet(plan, dict!)).toEqual([]);
    expect(validateRuleSet(ops, dict!)).toEqual([]);
  });
});

describe('RE-11 / RE-12 fixtures: what must fail validation', () => {
  for (const id of ['RE-11', 'RE-12']) {
    const fx = json(`fixtures/re/${id}.json`);
    for (const c of fx.cases) it(`${id} ${c.name}`, () => expect(codes(c.ruleSet)).toEqual([...c.expectedCodes].sort()));
  }
});

// Task 4.1 (D70, D71): a draft is a published file with edits applied. Each AU draft fails with exactly its code; each ID draft is publishable.
describe('AU-01..04 and ID fixtures: drafts', () => {
  const draft = (fx: { base: string; edits: Parameters<typeof applyEdits>[1] }) => applyEdits(json(`rules/electronics/${fx.base}.json`), fx.edits);
  for (const f of readdirSync('fixtures/au').filter((n) => n !== 'AU-05.json')) {
    const fx = json(`fixtures/au/${f}`);
    it(`${fx.id} ${fx.title}`, () => {
      expect(validateRuleSet(json(`rules/electronics/${fx.base}.json`), dict!)).toEqual([]);
      expect(validateRuleSet(draft(fx), dict!).map((i) => i.code)).toEqual(fx.expectedCodes);
    });
  }
  for (const f of readdirSync('fixtures/id')) {
    const fx = json(`fixtures/id/${f}`);
    it(`${fx.id} validates clean`, () => expect(validateRuleSet(draft(fx), dict!)).toEqual([]));
  }
  it('an edit whose path names nothing throws', () => expect(() => applyEdits(plan, [{ path: ['rules', 'E99', 'rows'], value: [] }])).toThrow('does not resolve'));
});

describe('closed vocabulary and publish rules', () => {
  const pass = { id: 'E5.pass', when: [{ fact: 'claim.serialMatchesContract', op: 'eq', value: true }], then: { outcome: 'PASS' } };
  it('accepts the baseline row', () => expect(codes(minimal(pass))).toEqual([]));
  it('rejects a float in rule data', () => expect(codes(minimal({ ...pass, when: [{ fact: 'claim.batteryCapacityPct', op: 'lt', value: 79.5 }] }))).toEqual(['SCHEMA']));
  it('rejects a red flag that carries claimant text', () => {
    const f = { id: 'F2.hit', when: pass.when, then: { outcome: 'REFER', reasonCode: 'X', noteText: 'n', claimantText: 'you look suspicious' } };
    const rs = { ...ops, rules: [{ ...ops.rules[0], kind: 'flag', rows: [f] }] };
    expect(codes(rs)).toEqual(['FLAG_CLAIMANT_TEXT']);
  });
  it('rejects a placeholder with no source', () => {
    const r = { id: 'E5.fail', when: pass.when, then: { outcome: 'REFER', reasonCode: 'X', noteText: 'n', claimantText: 'claim {nope}' } };
    expect(codes(minimal(r))).toEqual(['UNRESOLVED_PLACEHOLDER']);
  });
  it('rejects a non-PASS row with no explanation template', () => expect(codes(minimal({ id: 'E5.fail', when: pass.when, then: { outcome: 'DENY' } }))).toContain('MISSING_TEMPLATE'));
  it('rejects a duplicate row id', () => expect(codes({ ...ops, rules: [{ ...ops.rules[0], rows: [pass, pass] }] })).toEqual(['DUPLICATE_ID']));
  it('rejects a calc step that reads a register before it is set', () => {
    const bad = { ...plan, payout: { ...plan.payout, steps: [{ id: 'x', op: 'subtract', operand: { const: 1 } }, ...plan.payout.steps] } };
    expect(codes(bad)).toContain('UNDEFINED_REGISTER');
  });
  it('rejects a calc operand that is not a number', () => {
    const bad = { ...plan, payout: { ...plan.payout, steps: plan.payout.steps.map((s: { id: string }) => (s.id === 'c4' ? { ...s, operand: { fact: 'claim.peril' } } : s)) } };
    expect(codes(bad)).toContain('TYPE_MISMATCH');
  });
  it('rejects a derived fact whose argument is not declared', () => {
    const d = json('rules/electronics/facts-v1.json');
    d.facts.find((f: { id: string }) => f.id === 'd.daysSinceStart').args.from = 'contract.nope';
    expect(validateDictionary(d).issues.map((i) => i.code)).toEqual(['UNKNOWN_FACT']);
  });
});

describe('fixtures carry calc traces in the trace schema', () => {
  for (const f of readdirSync('fixtures/pay').filter((n) => json(`fixtures/pay/${n}`).kind === 'valuation')) // PAY-H and FP-H point at a denial: no steps
    it(f, () => { for (const s of json(`fixtures/pay/${f}`).expected.steps) expect(calcStepTraceSchema.safeParse(s).success).toBe(true); });
});

describe('unique lookups: overlap fails validation (D7, 1.8)', () => {
  const lookup = (...rows: object[]) => ({ ...plan, lookups: [...plan.lookups.slice(1), { id: 'deductibleCents', hitPolicy: 'unique', rows }] });
  const row = (id: string, ...when: object[]) => ({ id, when, value: 1 });
  const age = (op: string, value: unknown) => ({ fact: 'd.productAgeYears', op, value });
  const plus = { fact: 'contract.planCode', op: 'eq', value: 'plus' };

  it('plan-v1 tables are disjoint', () => expect(codes(plan)).toEqual([]));
  it('a duplicated row overlaps', () => expect(codes(lookup(row('a', plus), row('b', plus)))).toEqual(['OVERLAP']));
  it('a row with no condition on a fact overlaps a row that has one', () =>
    expect(codes(lookup(row('a', plus), row('b', plus, age('gte', 3))))).toEqual(['OVERLAP']));
  it('shared boundary overlaps; adjacent integer ranges do not', () => {
    expect(codes(lookup(row('a', age('between', [0, 2])), row('b', age('gte', 2))))).toEqual(['OVERLAP']);
    expect(codes(lookup(row('a', age('between', [0, 1])), row('b', age('gte', 2))))).toEqual([]);
  });
  it('dates: lt vs gte the same day are disjoint; lte vs gte overlap', () => {
    const d = (op: string) => ({ fact: 'claim.dateOfLoss', op, value: '2026-03-01' });
    expect(codes(lookup(row('a', d('lt')), row('b', d('gte'))))).toEqual([]);
    expect(codes(lookup(row('a', d('lte')), row('b', d('gte'))))).toEqual(['OVERLAP']);
  });
  it('enums: in vs not_in of the same list are disjoint; neq vs neq overlap', () => {
    const p = (op: string, value: unknown) => ({ fact: 'contract.planCode', op, value });
    expect(codes(lookup(row('a', p('in', ['plus'])), row('b', p('not_in', ['plus']))))).toEqual([]);
    expect(codes(lookup(row('a', p('neq', 'plus')), row('b', p('neq', 'premier'))))).toEqual(['OVERLAP']);
  });
});

// Hardening 2026-10-20. Date.parse rolls an impossible day over ('2023-02-29' parses as March 1), so the format check
// alone let a day that does not exist into rule data, a version's effectiveFrom and a staff-entered fact.
describe('dates are calendar days', () => {
  it('isIsoDate accepts real days, leap days included, and refuses ones that roll over', () => {
    expect(['2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01'].map(isIsoDate)).toEqual([true, true, true, true]);
    expect(['2023-02-29', '1900-02-29', '2026-04-31', '2026-02-30', '2026-13-01', '2026-00-10', '2026-1-01', '20260101', ''].map(isIsoDate))
      .toEqual([false, false, false, false, false, false, false, false, false]);
    expect([null, undefined, 20260101, new Date('2026-01-01')].map(isIsoDate)).toEqual([false, false, false, false]);
  });
  const row = (value: unknown) => ({ id: 'E5.when', when: [{ fact: 'claim.dateOfLoss', op: 'gte', value }], then: { outcome: 'PASS' } });
  it('a cell on a date fact must hold a real day', () => {
    expect(codes(minimal(row('2024-02-29')))).toEqual([]);
    expect(codes(minimal(row('2023-02-29')))).toEqual(['TYPE_MISMATCH']);
  });
  it('a version effective on a day that does not exist does not parse', () => {
    expect(codes({ ...ops, effectiveFrom: '2026-02-30' })).toEqual(['SCHEMA']);
  });
});

// Hardening 2026-10-20. The committed JSON Schemas had drifted (trace still said adjuster.trace/0). They are emitted
// by `npm run rules:schemas`; this holds them equal to the zod definitions so a schema change ships with its file.
describe('schemas/ is what `npm run rules:schemas` writes', () => {
  for (const [name, s] of [['fact-dictionary', dictionarySchema], ['rule-set', ruleSetSchema], ['trace', traceSchema]] as const)
    it(`${name}.schema.json`, () => expect(readFileSync(`schemas/${name}.schema.json`, 'utf8')).toBe(JSON.stringify(z.toJSONSchema(s), null, 2) + '\n'));
});
