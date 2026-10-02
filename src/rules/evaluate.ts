import type { Cell, Dictionary } from './schema';

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

// Maps a missing fact to the input facts it is computed from, so a PEND asks for something a person can supply.
export type Roots = (fact: string) => string[];
const self: Roots = (f) => [f];

// Derived facts resolve recursively to their declared args; input and lookup facts are their own root.
export function rootsOf(dict: Dictionary): Roots {
  const byId = new Map(dict.facts.map((f) => [f.id, f]));
  const roots: Roots = (id) => {
    const f = byId.get(id);
    if (f?.source !== 'derived') return [id];
    const args = ['from', 'to', 'num', 'den', 'list', 'anchor'].map((k) => f.args?.[k]).filter((a): a is string => typeof a === 'string');
    return [...new Set(args.flatMap(roots))].sort();
  };
  return roots;
}

// Names the missing roots in the UNKNOWN rows only (sorted, deduplicated).
function missingIn(rows: readonly { when: readonly Cell[] }[], truths: Truth[], facts: Facts, roots: Roots): string[] {
  const missing = rows
    .filter((_, i) => truths[i] === 'UNKNOWN')
    .flatMap((r) => r.when.filter((c) => evalCell(c, facts) === 'UNKNOWN').flatMap((c) => roots(c.fact)));
  return [...new Set(missing)].sort();
}

// Hit policy `collect` (D7). Collect every TRUE row (no first-match). A TRUE row outranks UNKNOWN rows; with none, any
// UNKNOWN row is PEND naming the missing facts; all FALSE is a rule gap, never an approval.
export function evalRule(rows: readonly Row[], facts: Facts, roots: Roots = self): RuleResult {
  const truths = rows.map((r) => evalRow(r.when, facts));
  const hits = rows.filter((_, i) => truths[i] === 'TRUE');
  if (hits.length) {
    const result = hits.map((r) => r.then.outcome).reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a));
    return { result, hits: hits.map((r) => r.id), missing: [] };
  }
  const missing = missingIn(rows, truths, facts, roots);
  if (missing.length) return { result: 'PEND', hits: [], missing };
  return { result: 'GAP', hits: [], missing: [] };
}

type LookupRow = { id: string; when: readonly Cell[]; value: FactValue };
export type LookupResult =
  | { result: 'HIT'; value: FactValue; hits: [string]; missing: [] }
  | { result: 'PEND' | 'GAP'; value: null; hits: []; missing: string[] };

// Hit policy `unique` (D7). Exactly one TRUE row gives the value. A TRUE row is decisive even beside UNKNOWN rows, since
// publish proved no two rows can both hold. Two TRUE rows here means an unvalidated table reached the engine: throw.
export function evalLookup(rows: readonly LookupRow[], facts: Facts, roots: Roots = self): LookupResult {
  const truths = rows.map((r) => evalRow(r.when, facts));
  const hits = rows.filter((_, i) => truths[i] === 'TRUE');
  if (hits.length > 1) throw new Error(`unique table matched ${hits.map((r) => r.id).join(', ')}`);
  if (hits.length) return { result: 'HIT', value: hits[0]!.value, hits: [hits[0]!.id], missing: [] };
  const missing = missingIn(rows, truths, facts, roots);
  return missing.length ? { result: 'PEND', value: null, hits: [], missing } : { result: 'GAP', value: null, hits: [], missing: [] };
}
