// Version selection (D35), pure. The plan is the contract's pin, never the date of loss, the date reported or the
// latest version. Ops is the latest non-draft version effective on `asOf`, boundary inclusive. A pin that is missing,
// a draft or not yet effective, or no effective ops, is NO_EFFECTIVE_VERSION naming the kind: there is no decision.
// Callers pass one product's versions. ISO dates compare as strings.
type Version = { name: string; kind: string; status: string; effectiveFrom: string };
export type Selection<V> = { plan: V; ops: V } | { error: 'NO_EFFECTIVE_VERSION'; kind: 'plan' | 'ops' };

export function selectVersions<V extends Version>(contract: { planVersion: string }, versions: readonly V[], asOf: string): Selection<V> {
  const effective = versions.filter((v) => v.status !== 'draft' && v.effectiveFrom <= asOf);
  const plan = effective.find((v) => v.kind === 'plan' && v.name === contract.planVersion);
  if (!plan) return { error: 'NO_EFFECTIVE_VERSION', kind: 'plan' };
  // ponytail: two ops versions effective from the same day pick the first listed; reject that at publish if it can happen
  const ops = effective.filter((v) => v.kind === 'ops').reduce<V | undefined>((a, b) => (a && a.effectiveFrom >= b.effectiveFrom ? a : b), undefined);
  if (!ops) return { error: 'NO_EFFECTIVE_VERSION', kind: 'ops' };
  return { plan, ops };
}
