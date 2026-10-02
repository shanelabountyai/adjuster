import { evalLookup, type FactValue, type Facts } from './evaluate';
import { divHalfUp } from './money';
import type { Dictionary, RuleSet } from './schema';

// Derived and lookup facts (D17, P4), computed from the frozen snapshot. Pure: dates arrive as ISO strings, never from a
// clock. Any missing input makes the derived fact null (UNKNOWN), never 0 or false. A lookup that pends or gaps is null
// too; the pipeline reports which, from evalLookup.

type PriorClaim = { claimId: string; dateOfLoss: string; peril: string; outcome: string; paidCents: number };
export type Snapshot = Readonly<Record<string, FactValue | readonly PriorClaim[] | null | undefined>>;
type Fact = Dictionary['facts'][number];

const DAY_MS = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY_MS; // ISO dates parse as UTC midnight: exact
function fullYears(from: string, to: string): number {
  const [y1, md1] = [Number(from.slice(0, 4)), from.slice(5)];
  const [y2, md2] = [Number(to.slice(0, 4)), to.slice(5)];
  return y2 - y1 - (md2 < md1 ? 1 : 0);
}

export function resolveFacts(snapshot: Snapshot, dict: Dictionary, plan: Pick<RuleSet, 'lookups'>): Facts {
  const byId = new Map(dict.facts.map((f) => [f.id, f]));
  const memo = new Map<string, unknown>();

  const get = (id: string): unknown => {
    if (id in snapshot) return snapshot[id] ?? null;
    if (memo.has(id)) return memo.get(id);
    const f = byId.get(id);
    const v = f?.source === 'derived' ? derive(f) : f?.source === 'lookup' ? lookup(id.slice(id.indexOf('.') + 1)) : null;
    memo.set(id, v);
    return v;
  };

  function lookup(name: string): FactValue | null {
    const table = plan.lookups?.find((l) => l.id === name);
    if (!table) return null;
    const facts = Object.fromEntries(table.rows.flatMap((r) => r.when).map((c) => [c.fact, get(c.fact) as FactValue | null]));
    return evalLookup(table.rows, facts).value;
  }

  function derive(f: Fact): FactValue | null {
    const a = f.args ?? {};
    const arg = (k: string) => get(a[k] as string);
    switch (f.fn) {
      case 'days_between':
      case 'full_years_between': {
        const [from, to] = [arg('from'), arg('to')] as [string | null, string | null];
        if (from === null || to === null) return null;
        return f.fn === 'days_between' ? days(from, to) : fullYears(from, to);
      }
      case 'ratio_bps':
      case 'ratio_exceeds_bps': {
        const [num, den] = [arg('num'), arg('den')] as [number | null, number | null];
        if (num === null || den === null) return null;
        if (f.fn === 'ratio_exceeds_bps') return num * 10000 > (a.bps as number) * den; // D26: cross-multiply, no rounding
        return den === 0 ? null : divHalfUp(num * 10000, den);
      }
      case 'sum_prior_paid': {
        const list = arg('list') as readonly PriorClaim[] | null;
        return list === null ? null : list.reduce((s, p) => s + p.paidCents, 0);
      }
      case 'count_claims_in_window': {
        const [list, anchor] = [arg('list'), arg('anchor')] as [readonly PriorClaim[] | null, string | null];
        const peril = a.peril as 'any' | 'same' | string[];
        const current = peril === 'same' ? (get('claim.peril') as string | null) : null;
        if (list === null || anchor === null || (peril === 'same' && current === null)) return null;
        const counts = a.counts as string[] | undefined;
        return list.filter((p) => {
          const age = days(p.dateOfLoss, anchor);
          return 0 <= age && age <= (a.windowDays as number)
            && (peril === 'any' || (peril === 'same' ? p.peril === current : peril.includes(p.peril)))
            && (!counts || counts.includes(p.outcome));
        }).length;
      }
      default: throw new Error(`${f.id}: unknown derived fn ${f.fn}`);
    }
  }

  const out: Record<string, FactValue | null> = {};
  for (const [k, v] of Object.entries(snapshot)) if (!Array.isArray(v)) out[k] = v as FactValue | null;
  for (const f of dict.facts) if (f.source === 'derived' || f.source === 'lookup') out[f.id] = get(f.id) as FactValue | null;
  return out;
}
