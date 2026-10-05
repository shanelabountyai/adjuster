import type { Trace } from './adjudicate';

// Letters and notes (D11, D42). Pure text from a stored trace: `{name}` placeholders are filled from the deciding
// row's stored `vars`, and nothing here reads rules, facts or a clock, so a stored decision renders the same bytes
// whatever is published later (PL-05). The outcome frame and the wording per calc op are code (both sets are closed);
// reason text and step labels are data.

type Rule = Trace['rules'][number];
type Step = NonNullable<Trace['valuation']>['steps'][number];

const fill = (template: string, vars: Rule['vars']) => template.replace(/\{(\w+)\}/g, (_, k: string) => {
  if (!Object.hasOwn(vars, k)) throw new Error(`unknown placeholder {${k}}`);
  return String(vars[k] ?? 'unknown');
});

// Two decimals from an integer (cents → dollars, bps → percent). Integer arithmetic only.
const dec2 = (n: number) => `${(n - (n % 100)) / 100}.${String(n % 100).padStart(2, '0')}`;
const money = (cents: number) => `${cents < 0 ? '-' : ''}$${dec2(Math.abs(cents))}`;

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

/** The claimant letter: the rules that decided the claim (D32), never a flag, a hidden rule or note text. */
export function renderLetter(t: Trace): string {
  const { outcome, reasons, payableCents, contractFulfilled } = t.decision;
  const shown = t.rules.filter((r) => reasons.includes(r.ruleId) && r.claimantVisible && r.claimantText !== null);
  if (outcome === 'DENY' && shown.length === 0) throw new Error('a denial letter needs at least one claimant-visible reason');
  const lines = [
    `Decision as of ${t.asOf}: ${outcome === 'DENY' ? `Denied for ${shown.length} reason${shown.length === 1 ? '' : 's'}.` : HEAD[outcome]}`,
    ...shown.map((r, i) => `(${i + 1}) ${fill(r.claimantText!, r.vars)}${r.clause ? ` (${r.clause})` : ''}`),
  ];
  if (outcome === 'APPROVE' || outcome === 'PARTIAL') {
    const { steps, labels } = t.valuation!;
    // A labelled step that set or changed an amount is a line; one that left it alone (a cap that did not bind) is only in the note.
    const moved = steps.filter((s) => s.applied && labels[s.id] && s.outputCents !== s.inputCents);
    lines.push(...moved.map((s) => mathLine(s, labels[s.id]!)), `Amount payable: ${money(payableCents!)}.`);
    if (contractFulfilled) lines.push('This payment fulfils your contract.');
  }
  if (outcome === 'DENY') lines.push('You may appeal this decision.');
  return `${lines.join('\n')}\n`;
}

/** The internal file note: versions, every non-PASS rule with its values, flags included, and every calc step in cents. */
export function renderNote(t: Trace): string {
  const d = t.decision;
  const hit = t.rules.filter((r) => r.result !== 'PASS');
  const lines = [
    `${d.outcome} as of ${t.asOf}. Payable cents: ${d.payableCents ?? 'none'}. Contract fulfilled: ${d.contractFulfilled ?? 'not determined'}.`,
    ...[t.versions.plan, t.versions.ops].map((v) => `Rules ${v.name}, effective ${v.effectiveFrom}, selected by ${v.selectedBy}, sha256 ${v.hash}.`),
    `${t.rules.length} rules ran, ${t.rules.length - hit.length} passed.${t.skipped.length ? ` Skipped stages: ${t.skipped.join(', ')}.` : ''}`,
    ...hit.map((r) => [
      `${r.ruleId} ${r.result}`, r.reasonCode, r.clause, r.rowIds.length ? `row ${r.rowIds.join(', ')}` : null,
    ].filter(Boolean).join(' ') + `: ${r.noteText ? fill(r.noteText, r.vars) : 'no note text.'}`
      + (r.missing.length ? ` Missing: ${r.missing.join(', ')}.` : '')
      + ` Facts: ${Object.entries(r.factsRead).map(([k, v]) => `${k}=${String(v)}`).join('; ')}.`),
  ];
  if (t.valuation) {
    lines.push(`Valuation (${t.valuation.path}):`, ...t.valuation.steps.map((s) => `${s.id} ${s.op} ${s.reg}: ${!s.applied ? 'not applied'
      : `${s.inputCents ?? '-'}, ${s.operand ? `${s.operand.name ?? s.operand.kind} ${s.operand.value}` : 'min'} -> ${s.outputCents}`}`));
  }
  return `${lines.join('\n')}\n`;
}
