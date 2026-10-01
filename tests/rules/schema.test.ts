import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calcStepTraceSchema } from '@/rules/schema';
import { validateDictionary, validateRuleSet } from '@/rules/validate';

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
  for (const f of readdirSync('fixtures/pay').filter((n) => n !== 'PAY-H.json'))
    it(f, () => { for (const s of json(`fixtures/pay/${f}`).expected.steps) expect(calcStepTraceSchema.safeParse(s).success).toBe(true); });
});
