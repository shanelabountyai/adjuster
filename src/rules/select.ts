// Version selection (D35), pure. The plan is the contract's pin, never the date of loss, the date reported or the
// latest version. Ops is the latest non-draft version effective on `asOf`, boundary inclusive. A pin that is missing,
// a draft or not yet effective, or no effective ops, is NO_EFFECTIVE_VERSION naming the kind: there is no decision.
// Callers pass one product's versions. ISO dates compare as strings.
type Version = { name: string; kind: string; status: string; effectiveFrom: string };
export type Selection<V> = { plan: V; ops: V } | { error: 'NO_EFFECTIVE_VERSION'; kind: 'plan' | 'ops' };

/** The ops version in force on `asOf`, of one product's versions: the latest non-draft one effective by then. */
// Two ops versions effective from the same day pick the first listed. `publishDraft` refuses the second (D77);
// ponytail: `publishRuleSet`, the seed's loader of files, does not
export const opsInForce = <V extends Omit<Version, 'name'>>(versions: readonly V[], asOf: string): V | undefined =>
  versions.filter((v) => v.kind === 'ops' && v.status !== 'draft' && v.effectiveFrom <= asOf)
    .reduce<V | undefined>((a, b) => (a && a.effectiveFrom >= b.effectiveFrom ? a : b), undefined);

export function selectVersions<V extends Version>(contract: { planVersion: string }, versions: readonly V[], asOf: string): Selection<V> {
  const effective = versions.filter((v) => v.status !== 'draft' && v.effectiveFrom <= asOf);
  const plan = effective.find((v) => v.kind === 'plan' && v.name === contract.planVersion);
  if (!plan) return { error: 'NO_EFFECTIVE_VERSION', kind: 'plan' };
  const ops = opsInForce(versions, asOf);
  if (!ops) return { error: 'NO_EFFECTIVE_VERSION', kind: 'ops' };
  return { plan, ops };
}
