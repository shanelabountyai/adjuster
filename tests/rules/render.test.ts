import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adjudicate } from '@/rules/adjudicate';
import { renderLetter, renderNote } from '@/rules/render';
import { validateDictionary } from '@/rules/validate';

// Task 2.9 (D42): letters and notes are text from the trace alone. Prose is not frozen in fixtures, so the letters
// the task names are pinned here in full.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const { dict } = validateDictionary(read('rules/electronics/facts-v1.json'));
const rs = (name: string) => read(`rules/electronics/${name}.json`);
const gc = (n: string) => {
  const fx = read(`fixtures/gc/GC-${n}.json`);
  return adjudicate({ plan: rs(fx.plan), ops: rs(fx.ops), dict: dict!, snapshot: fx.facts, asOf: fx.asOf });
};
const texts = (name: string, key: 'claimantText' | 'noteText') =>
  rs(name).rules.flatMap((r: { rows: { then: Record<string, string | undefined> }[] }) => r.rows.map((x) => x.then[key])).filter(Boolean) as string[];

describe('renderLetter', () => {
  it('GC-04: both reasons, each with its clause, and nothing from a rule that passed', () => {
    const t = gc('04');
    const f = read('fixtures/gc/GC-04.json').facts;
    expect(renderLetter(t)).toBe([
      `Decision as of ${t.asOf}: Denied for 2 reasons.`,
      `(1) The loss occurred outside your coverage term (${f['contract.termStart']}–${f['contract.termEnd']}). (§2.1)`,
      '(2) Cosmetic damage that does not affect function is excluded. (§4.3)',
      'You may appeal this decision.', '',
    ].join('\n'));
  });

  it('GC-14: both reasons with their clauses', () => {
    const letter = renderLetter(gc('14'));
    expect(letter).toContain('Denied for 2 reasons.');
    expect(letter).toContain('(1) Repairs or modifications by a non-authorized servicer are excluded. (§4.4)');
    expect(letter).toContain('(2) Products used commercially are excluded. (§4.5)');
  });

  it('GC-12: a referral letter is the neutral wording only: no flag id, no note text, no amount', () => {
    const t = gc('12');
    expect(t.decision.reasons).toEqual(['F1', 'F3']);
    const letter = renderLetter(t);
    expect(letter).toBe(`Decision as of ${t.asOf}: Your claim needs review by an adjuster. No decision has been made yet.\n`);
    expect(letter).not.toMatch(/\bF\d+\b|\$|375/);
    for (const r of t.rules.filter((x) => x.result !== 'PASS')) expect(letter).not.toContain(r.noteText!.split('{')[0]);
  });

  it('a claimantVisible: false rule never shows its stored text (D24)', () => {
    const t = gc('04');
    const hidden = { ...t, rules: t.rules.map((r) => (r.ruleId === 'E7' ? { ...r, claimantVisible: false } : r)) };
    const letter = renderLetter(hidden);
    expect(letter).toContain('Denied for 1 reason.');
    expect(letter).not.toContain('Cosmetic');
  });

  it('GC-01 and GC-13: the amount math line by line from the stored steps', () => {
    expect(renderLetter(gc('01')).split('\n')).toEqual(expect.arrayContaining([
      'Decision as of 2025-09-18: Approved.', 'Loss = covered repair cost C (repair path): $300.00',
      'Deductible: $300.00 − $50.00 = $250.00', 'Amount payable: $250.00.',
    ]));
    const partial = renderLetter(gc('13'));
    expect(partial).toContain('Approved in part.');
    expect(partial).toContain('Per-claim limit: the lesser of $570.00 and $500.00 = $500.00');
    expect(partial).toContain('Amount payable: $500.00.');
    expect(renderLetter(gc('01'))).not.toContain('Per-claim limit'); // a cap that did not bind is not a line
  });

  it('an unknown placeholder throws; a letter is never sent with a hole in it', () => {
    const t = gc('04');
    const broken = { ...t, rules: t.rules.map((r) => (r.ruleId === 'E2' ? { ...r, claimantText: 'Ended {when}.', noteText: 'Ended {when}.' } : r)) };
    expect(() => renderLetter(broken)).toThrow('unknown placeholder {when}');
    expect(() => renderNote(broken)).toThrow('unknown placeholder {when}');
  });

  it('every golden claim renders both documents, and no letter carries note or flag text', () => {
    const notes = [...texts('ops-v1', 'noteText'), ...texts('ops-v2', 'noteText')].map((n) => n.split('{')[0]!).filter((n) => n.length > 8);
    for (const n of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12', '13', '14']) {
      const t = gc(n);
      const letter = renderLetter(t);
      for (const note of notes) expect(letter).not.toContain(note);
      expect(renderNote(t)).toContain(`${t.decision.outcome} as of ${t.asOf}`);
    }
  });
});

describe('renderNote', () => {
  it('GC-12: the flags with their values, the versions, and every calc step in cents', () => {
    const t = gc('12');
    const note = renderNote(t);
    expect(note).toContain('REFER as of');
    expect(note).toContain('Payable cents: 37500.');
    expect(note).toMatch(/F1 REFER FLAG_F1 row F1\.hit: Loss 2 days after the waiting period ended\. Facts: d\.daysPastWaitingEnd=2\./);
    expect(note).toContain('F3 REFER FLAG_F3 row F3.hit: Proof of purchase is dated after the loss.');
    expect(note).toContain(`Rules ${t.versions.plan.name}, effective ${t.versions.plan.effectiveFrom}, selected by contract_pin, sha256 ${t.versions.plan.hash}.`);
    expect(note).toContain('c2 start_from L: not applied');
    expect(note).not.toMatch(/\bE1 /); // D32: a rule that passed is counted, not listed
  });

  it('GC-04: only the two rules that did not pass are listed, with the facts each read', () => {
    const note = renderNote(gc('04'));
    expect(note.split('\n').filter((l) => /^[EF][\d.A-Za-z]+ (DENY|REFER|PEND|GAP)/.test(l)).map((l) => l.split(' ')[0])).toEqual(['E2', 'E7']);
    expect(note).toContain('E2 DENY OUTSIDE_TERM §2.1 row E2.after: Loss 2028-01-24 outside 2025-01-15-2028-01-14. Facts: d.daysSinceStart=1104; d.daysToTermEnd=-10.');
    expect(note).toContain('Skipped stages: evidence, red_flags, valuation, deductible_limits, authority.');
  });
});
