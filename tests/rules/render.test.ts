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
      'Decision as of 2025-09-18: Approved.', 'Covered repair cost: $300.00',
      'Less your deductible: $300.00 − $50.00 = $250.00', 'Amount payable: $250.00.',
    ]));
    // D45: a step that only remembers a value has no label, so it is not a line (6 lines + the trailing newline)
    expect(renderLetter(gc('01')).split('\n')).toHaveLength(7);
    expect(renderLetter(gc('02'))).toContain('(1) Your plan does not cover accidental damage. (§3.1)'); // not the stored enum value
    const partial = renderLetter(gc('13'));
    expect(partial).toContain('Approved in part.');
    expect(partial).toContain("Your plan's limit for one claim: the lesser of $570.00 and $500.00 = $500.00");
    expect(partial).toContain('Amount payable: $500.00.');
    expect(renderLetter(gc('01'))).not.toContain('limit for one claim'); // a cap that did not bind is not a line
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

describe('the decision row (3.11, D62)', () => {
  const override = { overridesId: 'engine-row', asOf: '2025-02-04', payableCents: 37500, by: 'u-1', tier: 'adjuster', totalIncurredCents: 37500,
    opsHash: 'f'.repeat(64), reasonCode: 'FLAG_CLEARED', reasonText: 'Receipt reissued by the retailer; original sale confirmed.' };
  const rec = { decisionId: 'override-row', engine: 'adjuster.engine/7', waivers: [], facts: read('fixtures/gc/GC-12.json').facts as Record<string, unknown>,
    documents: [{ type: 'proofOfPurchase', version: 2, versionId: 'dv-1', sha256: 'a'.repeat(64) }] };

  it('GC-12 signed off: the letter is the approval with its math, on the override date, and says nothing of flags, reason or signer', () => {
    const letter = renderLetter(gc('12'), { override });
    expect(letter.split('\n')).toEqual(expect.arrayContaining(['Decision as of 2025-02-04: Approved.', 'Less your deductible: $400.00 − $25.00 = $375.00', 'Amount payable: $375.00.']));
    expect(letter).not.toMatch(/\bF\d+\b|FLAG|Receipt|retailer|adjuster|u-1|review/);
    // GC-10 refers on a rule that has claimant text: the referral shows only the neutral sentence (D42), and signed off, the referral's reason is not a reason of the approval
    expect(renderLetter(gc('10'))).toBe(`Decision as of ${gc('10').asOf}: Your claim needs review by an adjuster. No decision has been made yet.\n`);
    expect(renderLetter(gc('10'), { override })).not.toMatch(/\(1\)|does not match/);
  });

  it('GC-12 signed off: the note leads with who, tier, total incurred and reason, then the engine referral it overrides', () => {
    const lines = renderNote(gc('12'), { ...rec, override }).split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'APPROVE by override as of 2025-02-04. Payable cents: 37500. Decision override-row overrides decision engine-row.',
      `Decided by user u-1 at tier adjuster, tested on total incurred 37500 cents under ops rules sha256 ${'f'.repeat(64)}.`,
      'Override reason FLAG_CLEARED: Receipt reissued by the retailer; original sale confirmed.',
      'The engine decision overridden:',
      'REFER as of 2025-02-03. Calculated payable cents: 37500, not approved. Contract fulfilled: false.',
    ]);
    expect(lines).toContain(`Document relied on: proofOfPurchase version 2, id dv-1, sha256 ${'a'.repeat(64)}.`);
    expect(lines.join('\n')).not.toContain('Decided by the engine');
    // the dates behind F1's and F3's day counts, from the stored snapshot, in key order, before the valuation
    const at = (l: string) => lines.indexOf(l);
    expect(at('Facts as decided:')).toBeGreaterThan(0);
    expect([at('claim.dateOfLoss=2025-01-31'), at('contract.waitingEndsOn=2025-01-29'), at('history.priorClaims=[]')].every((i) => i > at('Facts as decided:') && i < at('Valuation (repair):'))).toBe(true);
    expect(at('claim.dateOfLoss=2025-01-31')).toBeLessThan(at('contract.waitingEndsOn=2025-01-29'));
    expect(renderNote(gc('12'))).not.toContain('Facts as decided'); // the trace alone holds no snapshot
  });

  it('an engine decision names the engine, its documents and its waivers; with none it says none', () => {
    const waivers = [{ type: 'secondEstimate', tier: 'adjuster', asOf: '2025-02-03', by: null, reasonText: 'No network servicer nearby.' }];
    const note = renderNote(gc('01'), { ...rec, waivers, override: null });
    expect(note).toContain('Decided by the engine (adjuster.engine/7), decision override-row; no person.');
    expect(note).toContain('Document waived: secondEstimate, by no recorded user at tier adjuster on 2025-02-03: No network servicer nearby.');
    expect(note).toContain('APPROVE as of 2025-09-18. Payable cents: 25000.'); // only a referral's amount is "calculated"
    expect(renderNote(gc('01'), { ...rec, documents: [], override: null })).toContain('Documents relied on: none.');
    expect(renderLetter(gc('01'), { override: null })).toBe(renderLetter(gc('01')));
  });

  it('a pend letter ends with what to do: send what is listed, or nothing when no reason is the claimant\'s to answer', () => {
    const pend = (drop: string) => {
      const fx = read('fixtures/gc/GC-01.json');
      return renderLetter(adjudicate({ plan: rs(fx.plan), ops: rs(fx.ops), dict: dict!, snapshot: { ...fx.facts, [drop]: drop.startsWith('docs.') ? 'requested' : null }, asOf: fx.asOf }));
    };
    expect(pend('docs.repairEstimate').split('\n').slice(1, 3)).toEqual(['(1) We need: repair estimate or diagnostic. (§8.1)', 'Please send us what is listed above. We will decide your claim when we have it.']);
    expect(pend('claim.serialMatchesContract').split('\n').slice(1, 2)).toEqual(['You do not need to send anything now. We will contact you if we need something from you.']);
  });
});

describe('renderNote', () => {
  it('GC-12: the flags with their values, the versions, and every calc step in cents', () => {
    const t = gc('12');
    const note = renderNote(t);
    expect(note).toContain('REFER as of');
    expect(note).toContain('REFER as of 2025-02-03. Calculated payable cents: 37500, not approved.'); // D62: not an amount anyone approved
    expect(note).toContain('c5 subtract L: 40000, lookup.deductibleCents 2500 -> 37500 (Less your deductible)');
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
