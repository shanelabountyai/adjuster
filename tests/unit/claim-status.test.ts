import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertTransition, CLAIM_STATUSES, IllegalTransitionError, type ClaimStatus, type CurrentDecision } from '@/adjudication/claim-status';

// PL-01 (D38): the code's table is exactly the fixture's. Every one of the 144 pairs is tried, so a move the fixture
// does not list must throw, and one it lists must not.
type Fx = {
  statuses: ClaimStatus[];
  transitions: { from: ClaimStatus; to: ClaimStatus; when?: string }[];
  guardCases: { name: string; from: ClaimStatus; decision: CurrentDecision | null; legal: ClaimStatus[] }[];
};
const fx: Fx = JSON.parse(readFileSync('fixtures/pl/PL-01.json', 'utf8'));
const legal = (from: ClaimStatus, to: ClaimStatus, d?: CurrentDecision | null) => {
  try { assertTransition(from, to, d); return true; } catch (e) {
    if (e instanceof IllegalTransitionError) return false;
    throw e;
  }
};

describe('PL-01 claim status transitions', () => {
  it('knows the same statuses', () => expect([...CLAIM_STATUSES].sort()).toEqual([...fx.statuses].sort()));

  it('allows exactly the unguarded moves in the table', () => {
    const want = fx.transitions.filter((t) => !t.when).map((t) => `${t.from}>${t.to}`).sort();
    const got = fx.statuses.flatMap((from) => fx.statuses.filter((to) => legal(from, to)).map((to) => `${from}>${to}`)).sort();
    expect(got).toEqual(want);
  });

  for (const c of fx.guardCases) {
    it(`leaving ${c.from}: ${c.name}`, () => {
      const guarded = fx.transitions.filter((t) => t.from === c.from && t.when).map((t) => t.to);
      expect(guarded.filter((to) => legal(c.from, to, c.decision)).sort()).toEqual([...c.legal].sort());
    });
  }

  it('a decision opens no move the table does not list', () => {
    const edges = new Set(fx.transitions.map((t) => `${t.from}>${t.to}`));
    for (const c of fx.guardCases) for (const from of fx.statuses) for (const to of fx.statuses)
      if (!edges.has(`${from}>${to}`)) expect(legal(from, to, c.decision)).toBe(false);
  });

  it('the error names both ends', () => {
    expect(() => assertTransition('PAID', 'OPEN')).toThrow(/PAID → OPEN/);
  });
});
