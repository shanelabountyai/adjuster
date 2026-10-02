import { sha256Hex } from './canonical';
import { evalCell, type FactValue } from './evaluate';
import { dictionarySchema, ruleSetSchema, type Cell, type Dictionary, type RuleSet } from './schema';

// Publish-time checks: structure (zod) first, then every cross-reference against the fact dictionary.
// Not an evaluator: it never reads a fact value, only declarations. Codes are the ones fixtures RE-11 and RE-12 assert.

export type IssueCode =
  | 'SCHEMA' | 'UNKNOWN_OPERATOR' | 'UNKNOWN_CALC_STEP' | 'UNKNOWN_FACT' | 'TYPE_MISMATCH' | 'DUPLICATE_ID'
  | 'MISSING_TEMPLATE' | 'UNRESOLVED_PLACEHOLDER' | 'FLAG_CLAIMANT_TEXT' | 'UNDEFINED_REGISTER' | 'BAD_STEP' | 'UNDEFINED_OUTPUT' | 'DICTIONARY_HASH' | 'OVERLAP';
export type Issue = { code: IssueCode; path: string; message: string };
type Fact = Dictionary['facts'][number];

const ORDERED = new Set(['int', 'cents', 'bps', 'date']);
const MONEYISH = new Set(['int', 'cents', 'bps']);
const fmt = (p: ReadonlyArray<PropertyKey>) => p.map(String).join('.');
const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function fits(f: Fact, v: unknown): boolean {
  switch (f.type) {
    case 'bool': return typeof v === 'boolean';
    case 'int': case 'cents': case 'bps': return Number.isInteger(v);
    case 'date': return isDate(v);
    case 'string': return typeof v === 'string';
    case 'enum': return typeof v === 'string' && !!f.values?.includes(v);
    default: return false;
  }
}

const shiftDay = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// D7: can one set of facts make every cell TRUE? Facts are tested independently (derived facts' links to their inputs are
// ignored), so this may report an overlap that real data cannot reach, never miss one. Per fact the candidates cover every
// region the literals carve out: the whole domain for bool/enum, each literal and its neighbours for ordered types, and
// one value equal to no literal for strings.
function canBothHold(cells: readonly Cell[], byId: ReadonlyMap<string, Fact>): boolean {
  return [...new Set(cells.map((c) => c.fact))].every((id) => {
    const f = byId.get(id)!;
    const mine = cells.filter((c) => c.fact === id);
    const lits = mine.flatMap((c) => (c.value === undefined ? [] : Array.isArray(c.value) ? c.value : [c.value]));
    const candidates: FactValue[] =
      f.type === 'bool' ? [true, false]
      : f.type === 'enum' ? f.values!
      : f.type === 'date' ? ['2000-01-01', ...(lits as string[]).flatMap((d) => [shiftDay(d, -1), d, shiftDay(d, 1)])]
      : f.type === 'string' ? [...lits, `${lits.join('')}~`]
      : [0, ...(lits as number[]).flatMap((n) => [n - 1, n, n + 1])];
    return candidates.some((v) => mine.every((c) => evalCell(c, { [id]: v }) === 'TRUE'));
  });
}

export function validateDictionary(input: unknown): { dict?: Dictionary; issues: Issue[] } {
  const parsed = dictionarySchema.safeParse(input);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => ({ code: 'SCHEMA', path: fmt(i.path), message: i.message })) };
  const dict = parsed.data;
  const issues: Issue[] = [];
  const byId = new Map(dict.facts.map((f) => [f.id, f]));
  if (byId.size !== dict.facts.length) issues.push({ code: 'DUPLICATE_ID', path: 'facts', message: 'duplicate fact id' });
  dict.facts.forEach((f, i) => {
    if (f.type === 'enum' && !f.values) issues.push({ code: 'SCHEMA', path: `facts.${i}`, message: 'enum fact needs values' });
    if (f.source === 'derived') {
      if (!f.fn) issues.push({ code: 'SCHEMA', path: `facts.${i}`, message: 'derived fact needs fn' });
      for (const k of ['from', 'to', 'num', 'den', 'list', 'anchor']) {
        const ref = f.args?.[k];
        if (typeof ref === 'string' && !byId.has(ref)) issues.push({ code: 'UNKNOWN_FACT', path: `facts.${i}.args.${k}`, message: `${ref} is not declared` });
      }
    }
  });
  return { dict, issues };
}

export function validateRuleSet(input: unknown, dict: Dictionary): Issue[] {
  const parsed = ruleSetSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => {
      const last = i.path[i.path.length - 1];
      const code: IssueCode = last === 'op' ? (i.path.includes('steps') ? 'UNKNOWN_CALC_STEP' : 'UNKNOWN_OPERATOR') : 'SCHEMA';
      return { code, path: fmt(i.path), message: i.message };
    });
  }
  return validateSemantics(parsed.data, dict);
}

// D28: a rule set is bound to the exact dictionary it was written against. Run at publish (and by rules:lint), on the raw file.
export function checkDictionaryHash(rs: { factDictionaryHash?: string }, dictFile: unknown): Issue[] {
  const want = sha256Hex(dictFile);
  if (rs.factDictionaryHash === want) return [];
  return [{ code: 'DICTIONARY_HASH', path: 'factDictionaryHash', message: rs.factDictionaryHash ? `does not match the dictionary (${want})` : `missing; the dictionary hashes to ${want}` }];
}

function validateSemantics(rs: RuleSet, dict: Dictionary): Issue[] {
  const issues: Issue[] = [];
  const add = (code: IssueCode, path: string, message: string) => issues.push({ code, path, message });
  const byId = new Map(dict.facts.map((f) => [f.id, f]));

  const cell = (c: Cell, path: string) => {
    const f = byId.get(c.fact);
    if (!f) return add('UNKNOWN_FACT', `${path}.fact`, `${c.fact} is not in the fact dictionary`);
    const v = c.value;
    const bad = (m: string) => add('TYPE_MISMATCH', path, `${c.fact} (${f.type}): ${m}`);
    if (f.type === 'list') return bad('list facts only feed derived facts');
    switch (c.op) {
      case 'is_known': if (v !== undefined) bad('is_known takes no value'); break;
      case 'eq': case 'neq': if (Array.isArray(v) || !fits(f, v)) bad(`${c.op} needs one ${f.type} value`); break;
      case 'lt': case 'lte': case 'gt': case 'gte':
        if (!ORDERED.has(f.type)) bad(`${c.op} is not defined for ${f.type}`); else if (Array.isArray(v) || !fits(f, v)) bad(`${c.op} needs one ${f.type} value`);
        break;
      case 'in': case 'not_in':
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => fits(f, x))) bad(`${c.op} needs a non-empty list of ${f.type} values`);
        break;
      case 'between':
        if (!ORDERED.has(f.type)) bad('between is not defined for ' + f.type);
        else if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => fits(f, x)) || (v[0] as string | number) > (v[1] as string | number)) bad(`between needs [low, high], both ${f.type}, low <= high`);
        break;
    }
  };

  const text = (then: RuleSet['rules'][number]['rows'][number]['then'], path: string) => {
    const known = new Set([...Object.keys(then.params ?? {}), ...Object.keys(then.bind ?? {})]);
    for (const [k, ref] of Object.entries(then.bind ?? {})) if (!byId.has(ref)) add('UNKNOWN_FACT', `${path}.then.bind.${k}`, `${ref} is not in the fact dictionary`);
    for (const t of [then.claimantText, then.noteText])
      for (const m of t?.matchAll(/\{(\w+)\}/g) ?? []) if (!known.has(m[1]!)) add('UNRESOLVED_PLACEHOLDER', path, `{${m[1]}} has no param or bind`);
  };

  const ids = new Set<string>();
  rs.rules.forEach((r, ri) => {
    if (ids.has(r.id)) add('DUPLICATE_ID', `rules.${ri}`, `rule ${r.id} appears twice`);
    ids.add(r.id);
    r.rows.forEach((row, wi) => {
      const p = `rules.${ri}.rows.${wi}`;
      if (ids.has(row.id)) add('DUPLICATE_ID', p, `row ${row.id} appears twice`);
      ids.add(row.id);
      row.when.forEach((c, ci) => cell(c, `${p}.when.${ci}`));
      text(row.then, p);
      if (row.then.outcome !== 'PASS') {
        if (!row.then.reasonCode) add('MISSING_TEMPLATE', p, 'a non-PASS row needs a reasonCode');
        if (!row.then.noteText) add('MISSING_TEMPLATE', p, 'a non-PASS row needs an internal noteText');
        if (r.kind === 'flag' && row.then.claimantText) add('FLAG_CLAIMANT_TEXT', p, 'red flags never appear in claimant text (PRD P0-4)');
        if (r.kind === 'eligibility' && row.then.claimantVisible !== false && !row.then.claimantText) add('MISSING_TEMPLATE', p, 'needs claimantText, or claimantVisible: false');
      }
    });
  });

  rs.lookups?.forEach((l, li) => {
    l.rows.forEach((row, wi) => row.when.forEach((c, ci) => cell(c, `lookups.${li}.rows.${wi}.when.${ci}`)));
    if (l.rows.some((r) => r.when.some((c) => !byId.has(c.fact)))) return; // already reported; no types to reason with
    l.rows.forEach((a, i) => l.rows.slice(i + 1).forEach((b) => {
      if (canBothHold([...a.when, ...b.when], byId)) add('OVERLAP', `lookups.${li}`, `unique table ${l.id}: rows ${a.id} and ${b.id} can both match`);
    }));
  });
  rs.fulfillment?.forEach((r, ri) => r.when.forEach((c, ci) => cell(c, `fulfillment.${ri}.when.${ci}`)));

  if (rs.kind === 'plan') {
    const defined = new Set((rs.lookups ?? []).map((l) => `lookup.${l.id}`));
    for (const f of dict.facts) if (f.source === 'lookup' && !defined.has(f.id)) add('UNDEFINED_OUTPUT', f.id, 'declared lookup fact has no lookup table in this plan');
    for (const f of dict.facts) if (f.source === 'calc' && !Object.keys(rs.payout?.outputs ?? {}).some((k) => `calc.${k}` === f.id)) add('UNDEFINED_OUTPUT', f.id, 'declared calc fact is not a payout output');
  }

  const regs = new Set<string>();
  rs.payout?.steps.forEach((s, si) => {
    const p = `payout.steps.${si}`;
    const reg = s.reg ?? 'L';
    s.when?.forEach((c, ci) => cell(c, `${p}.when.${ci}`));
    const operands = s.op === 'min_of' ? (s.operands ?? []) : s.operand ? [s.operand] : [];
    if (s.op === 'min_of' ? !s.operands : !s.operand || s.operands) add('BAD_STEP', p, `${s.op} takes ${s.op === 'min_of' ? 'operands (two or more)' : 'one operand'}`);
    for (const o of operands) {
      if ('fact' in o) {
        const f = byId.get(o.fact);
        if (!f) add('UNKNOWN_FACT', p, `${o.fact} is not in the fact dictionary`);
        else if (!MONEYISH.has(f.type)) add('TYPE_MISMATCH', p, `${o.fact} is ${f.type}, not a number`);
      } else if ('reg' in o && !regs.has(o.reg)) add('UNDEFINED_REGISTER', p, `register ${o.reg} read before it is set`);
    }
    if (s.op !== 'start_from' && s.op !== 'min_of' && !regs.has(reg)) add('UNDEFINED_REGISTER', p, `register ${reg} used before start_from`);
    regs.add(reg);
  });
  for (const [name, reg] of Object.entries(rs.payout?.outputs ?? {})) if (!regs.has(reg)) add('UNDEFINED_REGISTER', `payout.outputs.${name}`, `register ${reg} is never set`);

  return issues;
}
