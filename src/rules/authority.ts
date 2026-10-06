import type { RuleSet } from '@/rules/schema';

// Authority tiers are ops rule data (domain brief §7, D18). Pure.

type Tiers = NonNullable<RuleSet['authority']>;

/** The powers a tier holds: its own and those of every tier below it in the list (D51g). An unknown tier holds none. */
export const powersOf = (tiers: Tiers, tier: string): string[] =>
  tiers.slice(0, tiers.findIndex((t) => t.code === tier) + 1).flatMap((t) => t.powers);
