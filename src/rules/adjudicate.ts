import type { z } from 'zod';
import { valuate } from './calc';
import { resolveFacts, type Snapshot } from './derive';
import { evalRule, rootsOf, type Facts } from './evaluate';
import { STAGES, type Dictionary, type RuleSet, type ruleResultSchema, type traceSchema } from './schema';

// The engine: a frozen fact snapshot and two pinned rule sets in, a trace out (D12, D8). Pure: no clock, database or
// randomness; `asOf` is recorded, never read from a clock. Stage order is code, stage logic is data.
// Stages 1-5 always all run; an objective denial skips the rest. A pend stops valuation. A rule gap refers.
// Seam (P0-4): "contract not found" short-circuit arrives with the Phase 2 pipeline; no golden claim exercises it.

export type Trace = z.infer<typeof traceSchema>;
type RuleTrace = z.infer<typeof ruleResultSchema>;
type Rule = RuleSet['rules'][number];

export const ENGINE_SEMANTICS_VERSION = 'adjuster.engine/1';
const EARLY = STAGES.slice(0, 5) as readonly string[];
const SKIPPED_ON_DENY = ['evidence', 'red_flags', 'valuation', 'deductible_limits', 'authority'] as const;

export function adjudicate(input: { plan: RuleSet; ops: RuleSet; dict: Dictionary; snapshot: Snapshot; asOf: string }): Trace {
  const { plan, ops, dict, snapshot, asOf } = input;
  let facts: Facts = resolveFacts(snapshot, dict, plan);
  const roots = rootsOf(dict);
  const rules = [...plan.rules, ...ops.rules];
  const run = (stages: readonly string[]) => rules.filter((r) => stages.includes(r.stage)).map((r) => trace(r, facts, roots));

  const early = run(EARLY);
  const deny = early.some((r) => r.result === 'DENY') && ops.outcomePolicy?.autoDenyEnabled === true;
  const mid = deny ? [] : run(['evidence', 'red_flags']);
  const pend = [...early, ...mid].some((r) => r.result === 'PEND');

  let valuation: Trace['valuation'] = null, payableCents: number | null = null, contractFulfilled: boolean | null = null, late: RuleTrace[] = [];
  let partial = false;
  if (!deny && !pend) {
    const v = valuate(plan, facts);
    facts = { ...facts, ...v.calc };
    valuation = { path: v.path as 'repair' | 'replace', steps: v.steps };
    payableCents = v.payableCents;
    contractFulfilled = v.contractFulfilled;
    partial = payableCents! < (v.calc['calc.afterDeductibleCents'] as number);
    late = run(['authority']);
  }

  const all = [...early, ...mid, ...late].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  const results = all.map((r) => r.result);
  const outcome = deny ? 'DENY' : pend ? 'PEND' : results.some((r) => r === 'REFER' || r === 'GAP') ? 'REFER' : partial ? 'PARTIAL' : 'APPROVE';
  const key = outcome === 'REFER' ? ['REFER', 'GAP'] : [outcome];
  return {
    schema: 'adjuster.trace/0', asOf,
    planVersion: `${plan.kind}-v${plan.version}`, opsVersion: `${ops.kind}-v${ops.version}`,
    skipped: deny ? [...SKIPPED_ON_DENY] : [],
    rules: all,
    valuation,
    decision: {
      outcome,
      reasons: outcome === 'APPROVE' || outcome === 'PARTIAL' ? [] : all.filter((r) => key.includes(r.result)).map((r) => r.ruleId),
      payableCents, contractFulfilled,
    },
  };
}

// One rule's trace entry. The deciding row is the first TRUE row carrying the winning outcome; a gap has none.
function trace(rule: Rule, facts: Facts, roots: ReturnType<typeof rootsOf>): RuleTrace {
  const r = evalRule(rule.rows, facts, roots);
  const row = rule.rows.find((x) => r.hits.includes(x.id) && x.then.outcome === r.result)?.then;
  const read = [...new Set(rule.rows.flatMap((x) => x.when.map((c) => c.fact)))].sort();
  return {
    ruleId: rule.id, stage: rule.stage, result: r.result, rowIds: r.hits,
    reasonCode: r.result === 'GAP' ? 'RULE_GAP' : row?.reasonCode ?? null, clause: row?.clause ?? null,
    factsRead: Object.fromEntries(read.map((f) => [f, facts[f] ?? null])), missing: r.missing,
    claimantText: row?.claimantText ?? null, noteText: row?.noteText ?? null,
  };
}
