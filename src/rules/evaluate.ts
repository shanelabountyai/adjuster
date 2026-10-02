import type { Cell } from './schema';

// Kleene three-valued condition evaluation (D9). Pure: facts in, truth values out. A fact that is absent or null is
// UNKNOWN, never false; only is_known looks at presence itself. Types were checked at publish (validate.ts), so
// values here are same-typed: ints compare as numbers, ISO dates compare as strings.

export type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type FactValue = string | number | boolean;
export type Facts = Readonly<Record<string, FactValue | null | undefined>>;
export type Outcome = 'PASS' | 'DENY' | 'REFER' | 'PEND';

type Scalar = FactValue;
const known = (v: FactValue | null | undefined): v is FactValue => v !== undefined && v !== null;
const tv = (b: boolean): Truth => (b ? 'TRUE' : 'FALSE');

export function evalCell(cell: Cell, facts: Facts): Truth {
  const v = facts[cell.fact];
  if (cell.op === 'is_known') return tv(known(v));
  if (!known(v)) return 'UNKNOWN';
  const x = cell.value as Scalar; // scalar operators
  const xs = cell.value as Scalar[]; // in, not_in, between
  switch (cell.op) {
    case 'eq': return tv(v === x);
    case 'neq': return tv(v !== x);
    case 'lt': return tv(v < x);
    case 'lte': return tv(v <= x);
    case 'gt': return tv(v > x);
    case 'gte': return tv(v >= x);
    case 'in': return tv(xs.includes(v));
    case 'not_in': return tv(!xs.includes(v));
    case 'between': { const [lo, hi] = xs as [Scalar, Scalar]; return tv(lo <= v && v <= hi); }
  }
}

// Row AND: any FALSE wins, else any UNKNOWN, else TRUE. Every cell is evaluated so the trace can name all missing facts.
export function evalRow(when: readonly Cell[], facts: Facts): Truth {
  const rs = when.map((c) => evalCell(c, facts));
  return rs.includes('FALSE') ? 'FALSE' : rs.includes('UNKNOWN') ? 'UNKNOWN' : 'TRUE';
}

// D8: objective deny > pend > refer > pass.
const SEVERITY: Record<Outcome, number> = { PASS: 0, REFER: 1, PEND: 2, DENY: 3 };

type Row = { id: string; when: readonly Cell[]; then: { outcome: Outcome } };
export type RuleResult = { result: Outcome | 'GAP'; hits: string[]; missing: string[] };

// Collect every TRUE row (no first-match). A TRUE row outranks UNKNOWN rows; with none, any UNKNOWN row is PEND naming
// the missing facts (sorted, deduplicated); all FALSE is a rule gap, never an approval.
export function evalRule(rows: readonly Row[], facts: Facts): RuleResult {
  const truths = rows.map((r) => evalRow(r.when, facts));
  const hits = rows.filter((_, i) => truths[i] === 'TRUE');
  if (hits.length) {
    const result = hits.map((r) => r.then.outcome).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
    return { result, hits: hits.map((r) => r.id), missing: [] };
  }
  const missing = rows
    .filter((_, i) => truths[i] === 'UNKNOWN')
    .flatMap((r) => r.when.filter((c) => evalCell(c, facts) === 'UNKNOWN').map((c) => c.fact));
  if (missing.length) return { result: 'PEND', hits: [], missing: [...new Set(missing)].sort() };
  return { result: 'GAP', hits: [], missing: [] };
}
