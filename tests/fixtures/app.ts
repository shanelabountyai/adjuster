// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope. The template has no app tables, so it seeds none.
export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  void org;
  void key;
  return {};
}

// CLONE-OWNED. The clone's models with no orgId column, i.e. outside tenancy and RLS on purpose (INV-42, v1.7.0). Name
// each one with a comment saying why; a model without orgId that is not here (or in core's list) fails INV-42.
export const GLOBAL_MODELS: readonly string[] = [
  // v1.7.0 rollout: listed as found (INV-42). The reason is read from the schema; confirm or give the model an orgId.
  'RuleSetVersion', // no org relation; outside RLS and the org export
  'Contract', // no org relation; outside RLS and the org export
  'Claim', // no org relation; outside RLS and the org export
  'Document', // no org relation; outside RLS and the org export
  'DocumentVersion', // no org relation; outside RLS and the org export
  'DocumentRejectionReason', // no org relation; outside RLS and the org export
  'DocumentReview', // no org relation; outside RLS and the org export
  'DocumentWaiver', // no org relation; outside RLS and the org export
  'ClaimFact', // no org relation; outside RLS and the org export
  'Decision', // no org relation; outside RLS and the org export
  'OverrideReason', // no org relation; outside RLS and the org export
  'ClaimReminder', // no org relation; outside RLS and the org export
  'Payment', // no org relation; outside RLS and the org export
  'TierAssignment', // no org relation; outside RLS and the org export
];
