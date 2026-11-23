import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSteps, valuate } from '@/rules/calc';
import { resolveFacts } from '@/rules/derive';
import { applyBps } from '@/rules/money';
import { validateDictionary } from '@/rules/validate';

// Hardening 2026-10-20: engine behaviour the fixtures do not reach. The fixtures freeze the brief's claims; these pin
// the edges around them (a step no rule data uses yet, guards that are not TRUE, boundaries of the derived functions),
// each from a rule in CLAUDE.md or docs/decisions.md rather than from the code's current output.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
const plan = read('rules/electronics/plan-v1.json');

describe('calc steps beyond RE-13..RE-18', () => {
  it('min_of takes the smallest operand, reads no input register, and traces no single operand', () => {
    const { steps, registers } = runSteps([{ id: 'm', op: 'min_of', reg: 'L', operands: [{ const: 500 }, { fact: 'claim.coveredRepairCents' }, { const: 900 }] }], { 'claim.coveredRepairCents': 300 });
    expect(steps).toEqual([{ id: 'm', op: 'min_of', reg: 'L', applied: true, operand: null, inputCents: null, outputCents: 300 }]);
    expect(registers).toEqual({ L: 300 });
  });
  it('min_of with an unknown operand throws instead of ignoring it (unknown is never a number)', () =>
    expect(() => runSteps([{ id: 'm', op: 'min_of', reg: 'L', operands: [{ const: 500 }, { fact: 'claim.coveredRepairCents' }] }], {})).toThrow('claim.coveredRepairCents'));
  it('a step whose guard is UNKNOWN or FALSE is not applied and leaves the register as it was (only TRUE runs)', () => {
    const when = [{ fact: 'lookup.path', op: 'eq' as const, value: 'repair' }];
    const steps = [
      { id: 's', op: 'start_from' as const, reg: 'L', operand: { const: 1000 } },
      { id: 'g', op: 'subtract' as const, reg: 'L', operand: { const: 400 }, when },
    ];
    for (const facts of [{}, { 'lookup.path': 'replace' }]) {
      const r = runSteps(steps, facts);
      expect(r.steps[1]).toEqual({ id: 'g', op: 'subtract', reg: 'L', applied: false, operand: null, inputCents: null, outputCents: null });
      expect(r.registers.L).toBe(1000);
    }
    expect(runSteps(steps, { 'lookup.path': 'repair' }).registers.L).toBe(600);
  });
  it('subtract may go below zero; floor_at is what stops it (a deductible above the loss pays 0, D14)', () => {
    const r = runSteps([
      { id: 'a', op: 'start_from', reg: 'L', operand: { const: 3000 } },
      { id: 'b', op: 'subtract', reg: 'L', operand: { const: 5000 } },
      { id: 'c', op: 'floor_at', reg: 'L', operand: { const: 0 } },
    ], {});
    expect(r.steps.map((s) => s.outputCents)).toEqual([3000, -2000, 0]);
  });
  it('cap_at only lowers, floor_at only raises', () => {
    const run = (op: 'cap_at' | 'floor_at', start: number, v: number) =>
      runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { const: start } }, { id: 'b', op, reg: 'L', operand: { const: v } }], {}).registers.L;
    expect([run('cap_at', 100, 50), run('cap_at', 100, 500), run('floor_at', 100, 50), run('floor_at', 100, 500)]).toEqual([50, 100, 100, 500]);
  });
  it('apply_bps rounds once, half up (D16)', () => {
    const bps = (cents: number, b: number) => runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { const: cents } }, { id: 'b', op: 'apply_bps', reg: 'L', operand: { const: b } }], {}).registers.L;
    expect([bps(1005, 5000), bps(1003, 5000), bps(1, 5000), bps(1, 4999), bps(-1005, 5000)]).toEqual([503, 502, 1, 0, -503]);
  });
  it('apply_bps refuses a product past exact integer range instead of rounding a float', () => {
    expect(() => applyBps(2 ** 50, 10000)).toThrow('not exact integer math');
    expect(applyBps(2 ** 39, 10000)).toBe(2 ** 39); // about $5.5bn: still exact
  });
  it('a non-integer operand is refused, from a fact or from a constant (D16)', () => {
    expect(() => runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { fact: 'claim.coveredRepairCents' } }], { 'claim.coveredRepairCents': 10.5 })).toThrow('not an integer');
    expect(() => runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { fact: 'claim.coveredRepairCents' } }], { 'claim.coveredRepairCents': '1000' })).toThrow('not an integer');
    expect(() => runSteps([{ id: 'a', op: 'start_from', reg: 'L', operand: { const: 0.5 } }], {})).toThrow('not an integer');
  });
  it('registers are per call: the caller’s object is not written to', () => {
    const regs = { L: 7 };
    runSteps([{ id: 'a', op: 'subtract', reg: 'L', operand: { const: 2 } }], {}, regs);
    expect(regs).toEqual({ L: 7 });
  });
});

describe('valuate: fulfilment is three-valued', () => {
  const payout = { steps: [{ id: 'a', op: 'start_from' as const, reg: 'L', operand: { const: 100 } }], outputs: { payableCents: 'L' } };
  const row = (value: boolean) => ({ when: [{ fact: 'lookup.fulfillsOnReplace', op: 'eq' as const, value }] });
  it('TRUE row → fulfilled; only UNKNOWN rows → null, never false; all FALSE or none → false', () => {
    const v = (ful: { when: { fact: string; op: 'eq'; value: boolean }[] }[], facts: Record<string, boolean>) => valuate({ payout, fulfillment: ful } as never, facts).contractFulfilled;
    expect(v([row(true)], { 'lookup.fulfillsOnReplace': true })).toBe(true);
    expect(v([row(true), row(false)], {})).toBeNull();
    expect(v([row(true)], { 'lookup.fulfillsOnReplace': false })).toBe(false);
    expect(v([], {})).toBe(false);
  });
  it('the calc outputs become calc.* facts, and payable is the payableCents output', () => {
    const r = valuate({ payout } as never, {});
    expect(r.calc).toEqual({ 'calc.payableCents': 100 });
    expect(r.payableCents).toBe(100);
  });
  it('a rule set with no payout cannot valuate', () => expect(() => valuate({} as never, {})).toThrow('no payout'));
});

describe('derived facts at their boundaries (D17, D26); a missing input is UNKNOWN, never 0', () => {
  const base = { 'claim.dateOfLoss': '2026-06-30', 'claim.peril': 'adh' };
  const derive = (snapshot: Record<string, unknown>) => resolveFacts(snapshot as never, dict!, plan);
  const prior = (dateOfLoss: string, peril = 'adh', outcome = 'APPROVE', paidCents = 0) => ({ claimId: dateOfLoss, dateOfLoss, peril, outcome, paidCents });

  it('ratio_bps over a zero denominator is UNKNOWN, not Infinity; otherwise it rounds half up', () => {
    expect(derive({ 'claim.coveredRepairCents': 100, 'claim.replacementValueCents': 0 })['d.repairRatioBps']).toBeNull();
    expect(derive({ 'claim.coveredRepairCents': 1, 'claim.replacementValueCents': 3 })['d.repairRatioBps']).toBe(3333);
    expect(derive({ 'claim.coveredRepairCents': 2, 'claim.replacementValueCents': 3 })['d.repairRatioBps']).toBe(6667);
    expect(derive({ 'claim.coveredRepairCents': 1 })['d.repairRatioBps']).toBeNull();
  });
  it('ratio_exceeds_bps is strict and unrounded: exactly 70% does not exceed, one cent more does (D26)', () => {
    expect(derive({ 'claim.coveredRepairCents': 70000, 'claim.replacementValueCents': 100000 })['d.repairExceedsReplaceBps']).toBe(false);
    expect(derive({ 'claim.coveredRepairCents': 70001, 'claim.replacementValueCents': 100000 })['d.repairExceedsReplaceBps']).toBe(true);
    expect(derive({ 'claim.replacementValueCents': 100000 })['d.repairExceedsReplaceBps']).toBeNull();
  });
  it('days_between is signed and exact across a DST change and a leap day', () => {
    expect(derive({ 'contract.termStart': '2026-03-01', 'claim.dateOfLoss': '2026-03-31' })['d.daysSinceStart']).toBe(30);
    expect(derive({ 'contract.termStart': '2024-02-28', 'claim.dateOfLoss': '2024-03-01' })['d.daysSinceStart']).toBe(2);
    expect(derive({ 'contract.termStart': '2026-07-10', 'claim.dateOfLoss': '2026-07-01' })['d.daysSinceStart']).toBe(-9);
  });
  it('full_years_between counts a year only on or after the anniversary', () => {
    const age = (purchase: string, loss: string) => derive({ 'product.purchaseDate': purchase, 'claim.dateOfLoss': loss })['d.productAgeYears'];
    expect([age('2023-07-01', '2026-06-30'), age('2023-07-01', '2026-07-01'), age('2026-07-01', '2026-07-01')]).toEqual([2, 3, 0]);
  });
  it('a claim window is inclusive at both ends and never counts a claim dated after the loss', () => {
    const list = [prior('2026-06-30'), prior('2026-05-01'), prior('2026-04-30'), prior('2026-07-01')];
    // 60-day window back from 2026-06-30 reaches 2026-05-01 (60 days) but not 2026-04-30 (61); 2026-07-01 is after the loss
    expect(derive({ ...base, 'history.priorClaims': list })['d.claims60d']).toBe(2);
  });
  it('a window with `counts` ignores outcomes outside it; one with a peril list ignores other perils', () => {
    const list = [prior('2026-01-01', 'adh', 'APPROVE'), prior('2026-01-02', 'adh', 'DENY'), prior('2026-01-03', 'adh', 'PARTIAL'), prior('2026-01-04', 'breakdown', 'APPROVE')];
    expect(derive({ ...base, 'history.priorClaims': list })['d.claims12mAdh']).toBe(2);
  });
  it('a same-peril window with the current peril unknown is UNKNOWN, not a count of 0', () => {
    expect(derive({ 'claim.dateOfLoss': '2026-06-30', 'history.priorClaims': [prior('2026-06-29')] })['d.dupWithin7']).toBeNull();
    expect(derive({ ...base, 'history.priorClaims': [prior('2026-06-29'), prior('2026-06-28', 'breakdown')] })['d.dupWithin7']).toBe(1);
  });
  it('an empty claim history is a known 0; a missing one is UNKNOWN', () => {
    expect(derive({ ...base, 'history.priorClaims': [] })['d.sumPriorPaid']).toBe(0);
    expect(derive({ ...base, 'history.priorClaims': [] })['d.claims60d']).toBe(0);
    expect(derive(base)['d.sumPriorPaid']).toBeNull();
    expect(derive(base)['d.claims60d']).toBeNull();
  });
  it('the list itself never reaches the flat facts the conditions read', () =>
    expect('history.priorClaims' in derive({ ...base, 'history.priorClaims': [] })).toBe(false));
  it('is pure: the same snapshot gives the same facts, and the snapshot is not written to', () => {
    const snap = Object.freeze({ ...base, 'history.priorClaims': Object.freeze([prior('2026-06-01', 'adh', 'APPROVE', 500)]) });
    expect(derive(snap)).toEqual(derive(snap));
    expect(derive(snap)['d.sumPriorPaid']).toBe(500);
  });
});
