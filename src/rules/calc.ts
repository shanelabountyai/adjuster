import { z } from 'zod';
import { evalRow, type Facts } from './evaluate';
import { applyBps } from './money';
import type { RuleSet, calcStepTraceSchema, stepSchema } from './schema';

// Calc steps (D1): an ordered list over named integer registers. A step whose `when` is not TRUE is skipped and traced
// as not applied. Valuation only runs once eligibility passed, so an unknown operand or unset register here is a bug
// upstream: throw, never guess a 0.

type Step = z.infer<typeof stepSchema>;
type Operand = NonNullable<Step['operand']>;
type StepTrace = z.infer<typeof calcStepTraceSchema>;
type Registers = Record<string, number>;

export function runSteps(steps: readonly Step[], facts: Facts, registers: Registers = {}) {
  const regs = { ...registers };
  const value = (o: Operand): NonNullable<StepTrace['operand']> => {
    const [kind, name, v] = 'fact' in o ? ['fact', o.fact, facts[o.fact]] as const : 'const' in o ? ['const', null, o.const] as const : ['reg', o.reg, regs[o.reg]] as const;
    if (!Number.isSafeInteger(v)) throw new Error(`calc operand ${name ?? kind} is not an integer: ${String(v)}`);
    return { kind, name, value: v as number };
  };

  const trace = steps.map((s): StepTrace => {
    const reg = s.reg ?? 'L';
    if (s.when && evalRow(s.when, facts) !== 'TRUE') return { id: s.id, op: s.op, reg, applied: false, operand: null, inputCents: null, outputCents: null };
    const input = s.op === 'start_from' ? null : regs[reg] ?? null;
    if (s.op !== 'start_from' && s.op !== 'min_of' && input === null) throw new Error(`step ${s.id}: register ${reg} is unset`);

    let operand: StepTrace['operand'] = null;
    let out: number;
    if (s.op === 'min_of') out = Math.min(...s.operands!.map((o) => value(o).value));
    else {
      operand = value(s.operand!);
      const b = input!, v = operand.value;
      out = s.op === 'start_from' ? v : s.op === 'subtract' ? b - v : s.op === 'apply_bps' ? applyBps(b, v) : s.op === 'cap_at' ? Math.min(b, v) : Math.max(b, v);
    }
    regs[reg] = out;
    return { id: s.id, op: s.op, reg, applied: true, operand, inputCents: input, outputCents: out };
  });
  return { steps: trace, registers: regs };
}

// The plan's payout over resolved facts: path, step trace, payable, and whether this payment fulfils the contract.
// Outputs become `calc.<name>` facts so the fulfillment rows can read them.
export function valuate(plan: Pick<RuleSet, 'payout' | 'fulfillment'>, facts: Facts) {
  if (!plan.payout) throw new Error('rule set has no payout');
  const { steps, registers } = runSteps(plan.payout.steps, facts);
  const calc = Object.fromEntries(Object.entries(plan.payout.outputs).map(([k, reg]) => [`calc.${k}`, registers[reg] ?? null]));
  const all = { ...facts, ...calc };
  const ful = (plan.fulfillment ?? []).map((f) => evalRow(f.when, all));
  return {
    path: facts['lookup.path'],
    steps,
    payableCents: calc['calc.payableCents'] ?? null,
    // Unknown is never false: an UNKNOWN row with no TRUE one leaves fulfilment unknown.
    contractFulfilled: ful.includes('TRUE') ? true : ful.includes('UNKNOWN') ? null : false,
  };
}
