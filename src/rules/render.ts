import type { Trace } from './adjudicate';

// Letters and notes (D11, D42, D62). Pure text from a stored trace and, for what the trace does not hold, the decision
// row and the rows it points at (`DecisionRecord`): `{name}` placeholders are filled from the deciding
// row's stored `vars`, and nothing here reads rules, facts or a clock, so a stored decision renders the same bytes
// whatever is published later (PL-05). The outcome frame and the wording per calc op are code (both sets are closed);
// reason text and step labels are data.

/** What the decision row adds to its trace (D62): the engine or the person who decided, and the documents relied on. */
export type DecisionRecord = {
  decisionId: string;
  engine: string;
  facts: Record<string, unknown>; // the stored snapshot the decision was made on
  documents: { type: string; version: number; versionId: string; sha256: string }[];
  waivers: { type: string; tier: string; asOf: string; by: string | null; reasonText: string }[];
  // D89 b: the documents the snapshot shows as rejected, with the reason's claimant wording.
  rejections: { type: string; version: number; claimantText: string }[];
  // An override row carries the engine's trace (D59 c): its own date, amount, author and authority are columns.
  // On the engine row an appeal's decision wrote (D75): who decided the appeal.
  appeal?: { by: string; tier: string } | null;
  override: { overridesId: string; asOf: string; payableCents: number; by: string | null; tier: string; totalIncurredCents: number; opsHash: string; reasonCode: string; reasonText: string } | null;
};

type Rule = Trace['rules'][number];
type Step = NonNullable<Trace['valuation']>['steps'][number];

const fill = (template: string, vars: Rule['vars']) => template.replace(/\{(\w+)\}/g, (_, k: string) => {
  if (!Object.hasOwn(vars, k)) throw new Error(`unknown placeholder {${k}}`);
  return String(vars[k] ?? 'unknown');
});

// Two decimals from an integer (cents → dollars, bps → percent). Integer arithmetic only.
const dec2 = (n: number) => `${(n - (n % 100)) / 100}.${String(n % 100).padStart(2, '0')}`;
export const money = (cents: number) => `${cents < 0 ? '-' : ''}$${dec2(Math.abs(cents))}`;

function mathLine(s: Step, label: string) {
  const [a, v, out] = [s.inputCents!, s.operand?.value ?? 0, money(s.outputCents!)];
  switch (s.op) {
    case 'start_from': case 'min_of': return `${label}: ${out}`;
    case 'subtract': return `${label}: ${money(a)} − ${money(v)} = ${out}`;
    case 'apply_bps': return `${label}: ${money(a)} × ${dec2(v)}% = ${out}`;
    case 'cap_at': return `${label}: the lesser of ${money(a)} and ${money(v)} = ${out}`;
    case 'floor_at': return `${label}: the greater of ${money(a)} and ${money(v)} = ${out}`;
  }
}

const HEAD = {
  APPROVE: 'Approved.', PARTIAL: 'Approved in part.', DENY: 'Denied.',
  PEND: 'We need more information before we can decide your claim.',
  // The neutral wording (D19, D24): all a claimant sees of a flag or a `claimantVisible: false` rule.
  REFER: 'Your claim needs review by an adjuster. No decision has been made yet.',
} as const;

/**
 * The claimant letter: the rules that decided the claim (D32), never a flag, a hidden rule or note text. A signed-off
 * referral reads as the approval it is (D59 b), on the override's date, with none of the referral's reasons and
 * nothing of who signed or why (D62).
 */
export function renderLetter(t: Trace, rec?: Partial<Pick<DecisionRecord, 'override' | 'appeal' | 'rejections'>>): string {
  const { reasons, payableCents, contractFulfilled } = t.decision;
  const outcome = rec?.override ? 'APPROVE' : t.decision.outcome;
  // D42: a referral shows the neutral sentence only, even when the rule that referred it has claimant text (GC-10).
  // D89 b: a pend line that asks for a document the claimant sent and we rejected says why, from the reason's frozen wording.
  const rejected = (r: Rule) => {
    const x = outcome === 'PEND' ? rec?.rejections?.find((j) => r.factsRead[`docs.${j.type}`] === 'rejected') : undefined;
    return x ? ` The copy you sent was not accepted because ${x.claimantText}.` : '';
  };
  const shown = rec?.override || outcome === 'REFER' ? [] : t.rules.filter((r) => reasons.includes(r.ruleId) && r.claimantVisible && r.claimantText !== null);
  if (outcome === 'DENY' && shown.length === 0) throw new Error('a denial letter needs at least one claimant-visible reason');
  const lines = [
    `Decision as of ${rec?.override?.asOf ?? t.asOf}: ${outcome === 'DENY' ? `Denied for ${shown.length} reason${shown.length === 1 ? '' : 's'}.` : HEAD[outcome]}`,
    ...shown.map((r, i) => `(${i + 1}) ${fill(r.claimantText!, r.vars)}${r.clause ? ` (${r.clause})` : ''}${rejected(r)}`),
  ];
  if (outcome === 'APPROVE' || outcome === 'PARTIAL') {
    const { steps, labels } = t.valuation!;
    // A labelled step that set or changed an amount is a line; one that left it alone (a cap that did not bind) is only in the note.
    const moved = steps.filter((s) => s.applied && labels[s.id] && s.outputCents !== s.inputCents);
    lines.push(...moved.map((s) => mathLine(s, labels[s.id]!)), `Amount payable: ${money(payableCents!)}.`);
    if (contractFulfilled) lines.push('This payment fulfils your contract.');
  }
  // D75: a claim is appealed once, so the denial an appeal ends in says so instead of offering another.
  if (outcome === 'DENY') lines.push(rec?.appeal ? 'This decision was made on your appeal and is final.' : 'You may appeal this decision.');
  if (outcome === 'PEND') lines.push(shown.length ? 'Please send us what is listed above. We will decide your claim when we have it.'
    : 'You do not need to send anything now. We will contact you if we need something from you.');
  return `${lines.join('\n')}\n`;
}

/**
 * The internal file note: who decided and at what authority, the documents relied on, versions, every non-PASS rule
 * with its values, flags included, the stored facts, and every calc step in cents. An amount beside a referral is the engine's
 * calculation, and the note says so.
 */
export function renderNote(t: Trace, rec?: DecisionRecord): string {
  const d = t.decision;
  const o = rec?.override;
  const hit = t.rules.filter((r) => r.result !== 'PASS');
  const who = (id: string | null) => (id ? `user ${id}` : 'no recorded user');
  const lines = [
    ...(o ? [
      `APPROVE by override as of ${o.asOf}. Payable cents: ${o.payableCents}. Decision ${rec.decisionId} overrides decision ${o.overridesId}.`,
      `Decided by ${who(o.by)} at tier ${o.tier}, tested on total incurred ${o.totalIncurredCents} cents under ops rules sha256 ${o.opsHash}.`,
      `Override reason ${o.reasonCode}: ${o.reasonText}`,
      'The engine decision overridden:',
    ] : []),
    `${d.outcome} as of ${t.asOf}. ${d.outcome === 'REFER' && d.payableCents !== null ? `Calculated payable cents: ${d.payableCents}, not approved`
      : `Payable cents: ${d.payableCents ?? 'none'}`}. Contract fulfilled: ${d.contractFulfilled ?? 'not determined'}.`,
    ...(rec ? [
      ...(o ? [] : [`Decided by the engine (${rec.engine}), decision ${rec.decisionId}; ${rec.appeal ? `on appeal, decided by ${who(rec.appeal.by)} at tier ${rec.appeal.tier}` : 'no person'}.`]),
      ...(rec.documents.length + rec.waivers.length ? [] : ['Documents relied on: none.']),
      ...rec.documents.map((v) => `Document relied on: ${v.type} version ${v.version}, id ${v.versionId}, sha256 ${v.sha256}.`),
      ...rec.waivers.map((w) => `Document waived: ${w.type}, by ${who(w.by)} at tier ${w.tier} on ${w.asOf}: ${w.reasonText}`),
    ] : []),
    ...[t.versions.plan, t.versions.ops].map((v) => `Rules ${v.name}, effective ${v.effectiveFrom}, selected by ${v.selectedBy}, sha256 ${v.hash}.`),
    `${t.rules.length} rules ran, ${t.rules.length - hit.length} passed.${t.skipped.length ? ` Skipped stages: ${t.skipped.join(', ')}.` : ''}`,
    ...hit.map((r) => [
      `${r.ruleId} ${r.result}`, r.reasonCode, r.clause, r.rowIds.length ? `row ${r.rowIds.join(', ')}` : null,
    ].filter(Boolean).join(' ') + `: ${r.noteText ? fill(r.noteText, r.vars) : 'no note text.'}`
      + (r.missing.length ? ` Missing: ${r.missing.join(', ')}.` : '')
      + ` Facts: ${Object.entries(r.factsRead).map(([k, v]) => `${k}=${String(v)}`).join('; ')}.`),
  ];
  // Every stored input, sorted: where the dates behind a derived value such as a flag's day count are found (D62 h).
  if (rec) lines.push('Facts as decided:', ...Object.keys(rec.facts).sort().map((k) => `${k}=${typeof rec.facts[k] === 'object' ? JSON.stringify(rec.facts[k]) : String(rec.facts[k])}`));
  if (t.valuation) {
    lines.push(`Valuation (${t.valuation.path}):`, ...t.valuation.steps.map((s) => `${s.id} ${s.op} ${s.reg}: ${!s.applied ? 'not applied'
      : `${s.inputCents ?? '-'}, ${s.operand ? `${s.operand.name ?? s.operand.kind} ${s.operand.value}` : 'min'} -> ${s.outputCents}`}${t.valuation!.labels[s.id] ? ` (${t.valuation!.labels[s.id]})` : ''}`));
  }
  return `${lines.join('\n')}\n`;
}
