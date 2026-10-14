import type { Dictionary, RuleSet } from '@/rules/schema';

// Task 4.10 (D72, D88). A posted editor form applied to a draft's stored body. Each field is named by its path in the
// body, and only the paths D72 lets the editor change are applied: a posted rule id, stage, outcome or step order is
// ignored. Values are converted by the fact's type, never checked; saveDraft's validator says what is wrong.

const ROWS = String.raw`(?:rules|lookups)\.\d+\.rows`;
const WHEN = String.raw`(?:${ROWS}\.\d+|fulfillment\.\d+)\.when`;
const EDITABLE = [
  /^effectiveFrom$/,
  new RegExp(String.raw`^${ROWS}\.\d+\.id$`),
  new RegExp(String.raw`^${WHEN}\.\d+\.(?:fact|op|value)$`),
  /^rules\.\d+\.rows\.\d+\.then\.(?:claimantText|noteText)$/,
  /^lookups\.\d+\.rows\.\d+\.value$/,
  /^payout\.steps\.\d+\.(?:operand|operands\.\d+)\.const$/,
  /^authority\.\d+\.(?:approveUpToCents|powers)$/,
  /^reminders\.(?:firstDay|secondDay|closeDay)$/,
  /^outcomePolicy\.autoDenyEnabled$/,
];
const CELL_VALUE = new RegExp(String.raw`^${WHEN}\.\d+\.value$`);
const ADDABLE = new RegExp(String.raw`^(?:${ROWS}|${WHEN})$`);
const REMOVABLE = new RegExp(String.raw`^(?:${ROWS}|${WHEN})\.\d+$`);
const OPTIONAL = new Set(['value', 'claimantText', 'noteText']); // keys a field may add; any other must already be there
const LIST_OPS = new Set(['in', 'not_in', 'between']);
const INT = /^-?\d+$/;

type Obj = Record<string, unknown>;
const get = (root: unknown, keys: string[]) => keys.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), root);

/** A cell value from its input, typed by the fact. Text that does not fit the type is kept as text for the validator. */
function scalar(s: string, type: string | undefined) {
  const t = s.trim();
  if (t === '') return undefined;
  if (type === 'int' || type === 'cents' || type === 'bps') return INT.test(t) ? Number(t) : t;
  if (type === 'bool') return t === 'true' ? true : t === 'false' ? false : t;
  return t;
}

/** Any other field, typed by the value it replaces. A blank or non-integer number keeps the old value. */
function convert(key: string, s: string, cur: unknown) {
  const t = s.trim();
  if (Array.isArray(cur)) return t.split(',').map((x) => x.trim()).filter(Boolean);
  if (typeof cur === 'boolean') return t === 'true';
  if (key === 'approveUpToCents' && t === '') return null; // no limit
  if (typeof cur === 'number' || key === 'approveUpToCents') return INT.test(t) ? Number(t) : cur;
  if (key === 'claimantText' || key === 'noteText') return t === '' ? undefined : s;
  return t === '' ? cur : t;
}

export function applyForm(stored: RuleSet, dict: Dictionary, fields: Obj): Obj {
  const body = structuredClone(stored) as unknown as Obj;
  const types = new Map(dict.facts.map((f) => [f.id, f.type]));
  // A cell's value is read after its fact and operator, which decide its type.
  const posted = Object.entries(fields).filter(([p, v]) => typeof v === 'string' && EDITABLE.some((re) => re.test(p)));
  posted.sort(([a], [b]) => Number(CELL_VALUE.test(a)) - Number(CELL_VALUE.test(b)));

  for (const [path, v] of posted as [string, string][]) {
    const keys = path.split('.');
    const key = keys.pop()!;
    const parent = get(body, keys);
    if (!parent || typeof parent !== 'object' || (!(key in parent) && !OPTIONAL.has(key))) continue;
    const o = parent as Obj;
    let next: unknown;
    if (CELL_VALUE.test(path)) {
      const type = types.get(o.fact as string);
      next = o.op === 'is_known' ? undefined
        : LIST_OPS.has(o.op as string) ? v.split(',').map((x) => scalar(x, type)).filter((x) => x !== undefined)
        : scalar(v, type);
    } else next = convert(key, v, o[key]);
    if (next === undefined) delete o[key];
    else o[key] = next;
  }

  const [verb, at = ''] = String(fields._do ?? '').split(':');
  const list = get(body, at.split('.'));
  if (verb === 'add' && ADDABLE.test(at) && Array.isArray(list)) {
    const last = list.at(-1) as Obj | undefined;
    if (at.endsWith('.rows')) {
      const ids = new Set(list.map((r) => (r as Obj).id));
      let n = 1;
      while (ids.has(`${last!.id}.${n}`)) n++;
      list.push({ ...structuredClone(last!), id: `${last!.id}.${n}` });
    } else list.push(last ? structuredClone(last) : { fact: dict.facts.find((f) => f.type !== 'list')!.id, op: 'is_known' });
  }
  if (verb === 'remove' && REMOVABLE.test(at)) {
    const keys = at.split('.');
    const i = Number(keys.pop());
    const arr = get(body, keys);
    // a table keeps one row: the schema needs it, and a body that does not parse cannot be shown as a form
    if (Array.isArray(arr) && i < arr.length && !(keys.at(-1) === 'rows' && arr.length === 1)) arr.splice(i, 1);
  }
  return body;
}
