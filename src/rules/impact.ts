import { adjudicate, type Trace } from './adjudicate';
import { canonicalJson } from './canonical';
import type { Snapshot } from './derive';
import type { Dictionary, RuleSet } from './schema';

// The impact diff (task 4.4, D71), pure. Each case is one stored engine decision: its fact snapshot, its `asOf`, the
// plan its contract pins, the ops version it ran under, and its stored trace. The draft stands in for the version of
// its own kind; the other stays. `before` is read from the stored trace and never recomputed, so the diff shows what
// the claim was told, not what today's engine would say of the old rules.

type Result = Pick<Trace['decision'], 'outcome' | 'reasons' | 'payableCents'>;
export type ImpactCase = { claim: string; snapshot: Snapshot; asOf: string; plan: RuleSet; ops: RuleSet; trace: { decision: Result } };
export type Delta = { claim: string; before: Result; after: Result };

const resultOf = ({ outcome, reasons, payableCents }: Result): Result => ({ outcome, reasons, payableCents });

/** A claim has moved when its outcome, its reasons or its payable cents differ. */
export function impactDiff(draft: RuleSet, dict: Dictionary, cases: readonly ImpactCase[]): { changed: Delta[]; unchanged: number } {
  const changed = cases.flatMap((c): Delta[] => {
    const before = resultOf(c.trace.decision);
    const after = resultOf(adjudicate({
      plan: draft.kind === 'plan' ? draft : c.plan, ops: draft.kind === 'ops' ? draft : c.ops, dict, snapshot: c.snapshot, asOf: c.asOf,
    }).decision);
    return canonicalJson(before) === canonicalJson(after) ? [] : [{ claim: c.claim, before, after }];
  });
  return { changed, unchanged: cases.length - changed.length };
}

/** The coverage report (D67): the rows of `rs` that none of the traces hit. A row the draft adds is always listed. */
// ponytail: rule rows only. A trace does not record which lookup row answered, so lookup rows are not reported;
// that needs the row id on the trace (a new trace version) first.
export function unhitRows(rs: RuleSet, traces: readonly { rules: readonly { ruleId: string; rowIds: readonly string[] }[] }[]): { ruleId: string; rowId: string }[] {
  const hit = new Set(traces.flatMap((t) => t.rules.flatMap((r) => r.rowIds.map((id) => canonicalJson([r.ruleId, id])))));
  return rs.rules.flatMap((r) => r.rows.filter((x) => !hit.has(canonicalJson([r.id, x.id]))).map((x) => ({ ruleId: r.id, rowId: x.id })));
}
