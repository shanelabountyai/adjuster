import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { publishRuleSet } from '@/adjudication/decisions';
import { type DocumentStore, LocalDiskDocumentStore, reviewDocument, uploadDocument } from '@/adjudication/documents';
import { assignTier } from '@/adjudication/authority';
import { runNoResponse } from '@/adjudication/no-response';
import { mockPaymentProvider } from '@/adjudication/payments';
import { acceptEvidence, adjudicateClaim, openClaim, overrideDecision, payClaim, reopenClaim, uploadEvidence, waiveEvidence } from '@/adjudication/pipeline';

// The clean seed for decisions:verify (task 2.11): both plan and both ops versions published, then every claim filed
// as a contract and a claim and decided by the pipeline, which picks the versions. GC-01..10 and 12..14, the RV-01
// pair (one loss under a plan-v1 and a plan-v2 contract), and GC-01's claim on the last day of ops-v1 and the first
// of ops-v2. Synthetic claims only. Replaces every rule set, contract, claim and decision in the target database.
// Each document a golden claim calls accepted is uploaded and accepted through the services (task 3.4), and the facts
// that document carries are entered with the acceptance. The bytes are a placeholder line under uploads/ (gitignored).
// Task 3.12: GC-11 and GC-15 are played event by event through the services (no response, waiver, override, payment,
// reopen), and GC-05's referral is signed off. The two lives go first: the no-response job reads every open claim.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const onContract = ([k]: [string, unknown]) => k.startsWith('contract.') || k.startsWith('product.');

// Which facts each document carries: the accept actions of EV-05, the one claim life that files all four.
const CARRIED: Record<string, string[]> = Object.fromEntries((read('fixtures/ev/EV-05.json').events as { action: { type: string; version: string; facts: object } }[])
  .filter((e) => e.action.type === 'accept').map((e) => [e.action.version.split('/')[0], Object.keys(e.action.facts)]));

type Db = Parameters<typeof publishRuleSet>[0];

/** Files a fixture's flat fact list as a contract, a claim and its accepted documents. Facts of a document not yet accepted stay on the claim as filed. */
export async function fileClaim(db: Db, store: DocumentStore, planVersionId: string | undefined, c: { id: string; facts: Record<string, unknown> }) {
  const facts = Object.entries(c.facts);
  const docs = facts.filter(([k]) => k.startsWith('docs.')).map(([k, v]) => [k.slice(5), v] as const);
  const odd = docs.find(([, v]) => v !== 'accepted' && v !== 'requested');
  if (odd) throw new Error(`fileClaim: ${c.id} has a ${odd[1]} ${odd[0]}; only accepted and requested are filed`);
  const accepted = docs.filter(([, v]) => v === 'accepted').map(([t]) => t);
  const fromDoc = new Set(accepted.flatMap((t) => CARRIED[t] ?? []));
  await db.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${c.id}`, planVersionId, Object.fromEntries(facts.filter(onContract))]);
  await db.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)',
    [c.id, `CT-${c.id}`, Object.fromEntries(facts.filter((e) => !onContract(e) && !e[0].startsWith('docs.') && !fromDoc.has(e[0])))]);
  for (const type of accepted) await acceptDocument(db, store, c.id, type, Object.fromEntries(facts.filter(([k]) => CARRIED[type]?.includes(k))));
}

export async function acceptDocument(db: Db, store: DocumentStore, claimId: string, type: string, facts: Record<string, unknown> = {}) {
  const { versionId } = await uploadDocument(db, store, { claimId, type, bytes: new TextEncoder().encode(`synthetic ${type} for ${claimId}\n`), source: 'claimant', uploadedBy: null });
  await reviewDocument(db, { versionId, result: 'accepted', userId: null, facts });
}

export type LifeEvent = { asOf: string; action: { type: string; facts: Record<string, unknown>; doc: string; version: string; by: string; reasonText: string; reasonCode: string; reason: string } };
/** A claim life being played: `versions` maps a fixture's version label to the id its upload got, `staff` gives a user holding a tier. */
export type Life = { db: Db; store: DocumentStore; claimId: string; planVersionId: string | undefined; staff: (tier: string) => Promise<string>; versions: Map<string, string> };

/** Plays one event of a claim life through the service a person or the job would call, and returns what the service returned. */
export async function playEvent({ db, store, claimId, planVersionId, staff, versions }: Life, { asOf, action: a }: LifeEvent, i: number) {
  switch (a.type) {
    case 'open': {
      const facts = Object.entries(a.facts);
      await db.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)', [`CT-${claimId}`, planVersionId, Object.fromEntries(facts.filter(onContract))]);
      return openClaim(db, { id: claimId, contractId: `CT-${claimId}`, facts: Object.fromEntries(facts.filter((f) => !onContract(f))) as never }, asOf);
    }
    case 'upload': {
      const u = await uploadEvidence(db, store, { claimId, type: a.doc, bytes: new TextEncoder().encode(`${claimId} ${a.doc} ${i}`), source: 'claimant', uploadedBy: null });
      versions.set(a.version, u.versionId);
      return u;
    }
    case 'accept': return acceptEvidence(db, { versionId: versions.get(a.version)!, facts: a.facts, userId: null }, asOf);
    case 'waive': return waiveEvidence(db, { claimId, type: a.doc, reasonText: a.reasonText, asOf, userId: await staff(a.by) });
    case 'tick': return runNoResponse(db, asOf);
    case 'override': return overrideDecision(db, { claimId, userId: await staff(a.by), reasonCode: a.reasonCode, reasonText: a.reasonText, asOf });
    case 'pay': return payClaim(db, mockPaymentProvider, { claimId, asOf, userId: null });
    case 'reopen': return reopenClaim(db, { claimId, userId: await staff('adjuster'), reason: a.reason });
    default: throw new Error(`playEvent: ${a.type}`);
  }
}

/** The override reason codes the migration seeds, put back by its own statement: the test suite's reset empties every table, reference rows included. */
export const seedOverrideReasons = (db: Db) => db.query(readFileSync('prisma/migrations/20261012020000_override_authority/migration.sql', 'utf8')
  .match(/INSERT INTO "OverrideReason"[^;]+/)![0] + ' ON CONFLICT DO NOTHING');

export async function seedDecisions(db: Db, store: DocumentStore = new LocalDiskDocumentStore('uploads/documents')) {
  await db.query('TRUNCATE "TierAssignment", "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
  await seedOverrideReasons(db);
  const versions: Record<string, string> = {};
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versions[name] = await publishRuleSet(db, read(`rules/electronics/${name}.json`));

  const users: Record<string, string> = {};
  const staff = async (tier: string) => {
    if (!users[tier]) await assignTier(db, { userId: (users[tier] = randomUUID()), tier, by: null });
    return users[tier]!;
  };
  for (const n of ['11', '15']) {
    const fx: { id: string; plan: string; events: LifeEvent[] } = read(`fixtures/gc/GC-${n}.json`);
    const life: Life = { db, store, claimId: fx.id, planVersionId: versions[fx.plan], staff, versions: new Map() };
    for (const [i, e] of fx.events.entries()) await playEvent(life, e, i);
  }

  const golden = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map((n) => read(`fixtures/gc/GC-${String(n).padStart(2, '0')}.json`));
  const [soldBefore, soldAfter] = read('fixtures/rv/RV-01.json').cases;
  const opsV2From: string = read('rules/electronics/ops-v2.json').effectiveFrom;
  const dayBefore = new Date(Date.parse(opsV2From) - 86_400_000).toISOString().slice(0, 10);
  const claims: { id: string; plan: string; facts: Record<string, unknown>; asOf: string }[] = [
    ...golden,
    { ...soldBefore, id: 'RV-01-v1' }, { ...soldAfter, id: 'RV-01-v2' },
    { ...golden[0], id: 'OPS-v1-last-day', asOf: dayBefore }, { ...golden[0], id: 'OPS-v2-first-day', asOf: opsV2From },
  ];

  const decisions: Record<string, string> = {};
  for (const c of claims) {
    await fileClaim(db, store, versions[c.plan], c);
    const r = await adjudicateClaim(db, c.id, c.asOf);
    if ('error' in r) throw new Error(`seed:decisions: ${c.id} was not decided (${r.error}: ${r.detail})`);
    decisions[c.id] = r.decisionId;
  }
  const so = golden[4].signoff;
  decisions['GC-05-signoff'] = (await overrideDecision(db, { claimId: 'GC-05', userId: await staff(so.by), reasonCode: so.reasonCode, reasonText: so.reasonText, asOf: so.asOf })).decisionId;
  return { versions, decisions };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedDecisions(client);
    console.log(`seed:decisions: ${(await client.query('SELECT count(*) FROM "Decision"')).rows[0].count} decisions`);
  } finally {
    await client.end();
  }
}
