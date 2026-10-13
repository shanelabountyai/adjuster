import type { RuleSet } from '@/rules/schema';

// Authority tiers are ops rule data (domain brief §7, D18). Pure.

type Tiers = NonNullable<RuleSet['authority']>;

/** The powers a tier holds: its own and those of every tier below it in the list (D51g). An unknown tier holds none. */
export const powersOf = (tiers: Tiers, tier: string | null): string[] =>
  tiers.slice(0, tiers.findIndex((t) => t.code === tier) + 1).flatMap((t) => t.powers);

/** The power an override needs (D48): the one that clears a flag, when a reason it sets aside is a rule of kind `flag`. */
export const powerToOverride = (rules: RuleSet['rules'], reasons: string[]): string | null =>
  rules.some((r) => r.kind === 'flag' && reasons.includes(r.id)) ? 'clear_flags' : null;

export type AuthorityCheck = { totalIncurredCents: number; allowed: boolean; lacks: ('amount' | 'power')[] };

/**
 * Whether a tier may approve `amountCents` on a claim that has been paid `paidCents`, using `power` if one is needed.
 * The limit is inclusive and is tested on total incurred, the larger of the two (D50): never on the payment about to
 * go out. Everything lacking is reported (D51g). A tier the list does not name approves nothing, not even 0 (D58).
 */
export function checkAuthority(tiers: Tiers, tier: string | null, power: string | null, paidCents: number, amountCents: number): AuthorityCheck {
  const held = tiers.find((t) => t.code === tier);
  const totalIncurredCents = Math.max(paidCents, amountCents);
  const lacks: AuthorityCheck['lacks'] = [];
  if (!held || (held.approveUpToCents !== null && totalIncurredCents > held.approveUpToCents)) lacks.push('amount');
  if (power !== null && !powersOf(tiers, tier).includes(power)) lacks.push('power');
  return { totalIncurredCents, allowed: lacks.length === 0, lacks };
}
