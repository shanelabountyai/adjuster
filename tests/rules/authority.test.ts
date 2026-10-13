import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ov01 from '../../fixtures/ov/OV-01.json';
import ov02 from '../../fixtures/ov/OV-02.json';
import ov03 from '../../fixtures/ov/OV-03.json';
import ov04 from '../../fixtures/ov/OV-04.json';
import { checkAuthority } from '@/rules/authority';

// Task 3.7 (D50, D51g, D58): the authority check, against the tier list of the ops rule set each fixture names.

const tiersOf = (ops: string) => JSON.parse(readFileSync(`rules/electronics/${ops}.json`, 'utf8')).authority;

describe('checkAuthority', () => {
  for (const fx of [ov01, ov02, ov03, ov04]) {
    describe(`${fx.id}: ${fx.title}`, () => {
      it.each(fx.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
        expect(checkAuthority(tiersOf(fx.ops), c.tier, c.power, c.paidCents, c.amountCents)).toEqual(c.expected);
      });
    });
  }

  it('reads the limit from the ops version it is given', () => {
    const [v1, v2] = ['ops-v1', 'ops-v2'].map(tiersOf);
    const lowest = v1[0].code;
    expect(v1[0].approveUpToCents).toBeLessThan(v2[0].approveUpToCents);
    expect(checkAuthority(v1, lowest, null, 0, v2[0].approveUpToCents).lacks).toEqual(['amount']);
    expect(checkAuthority(v2, lowest, null, 0, v2[0].approveUpToCents).lacks).toEqual([]);
  });

  it('a power is held only under an ops version that names it (D68)', () => {
    const c = ov04.cases[0]!;
    expect(c.expected.allowed).toBe(true);
    expect(checkAuthority(tiersOf('ops-v2'), c.tier, c.power, 0, 0).lacks).toEqual(['power']);
  });

  it('a tier the list does not name, or no tier, approves nothing', () => {
    const tiers = tiersOf('ops-v1');
    expect(checkAuthority(tiers, 'nobody', null, 0, 0)).toEqual({ totalIncurredCents: 0, allowed: false, lacks: ['amount'] });
    expect(checkAuthority(tiers, null, tiers[1].powers[0], 0, 0).lacks).toEqual(['amount', 'power']);
    expect(checkAuthority([], tiers[3].code, null, 0, 1).allowed).toBe(false);
  });
});
