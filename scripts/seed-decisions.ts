import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { publishRuleSet } from '@/adjudication/decisions';
import { type DocumentStore, LocalDiskDocumentStore, reviewDocument, uploadDocument } from '@/adjudication/documents';
import { adjudicateClaim } from '@/adjudication/pipeline';

// The clean seed for decisions:verify (task 2.11): both plan and both ops versions published, then every claim filed
// as a contract and a claim and decided by the pipeline, which picks the versions. GC-01..10 and 12..14, the RV-01
// pair (one loss under a plan-v1 and a plan-v2 contract), and GC-01's claim on the last day of ops-v1 and the first
// of ops-v2. Synthetic claims only. Replaces every rule set, contract, claim and decision in the target database.
// Each document a golden claim calls accepted is uploaded and accepted through the services (task 3.4), and the facts
// that document carries are entered with the acceptance. The bytes are a placeholder line under uploads/ (gitignored).
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

export async function seedDecisions(db: Db, store: DocumentStore = new LocalDiskDocumentStore('uploads/documents')) {
  await db.query('TRUNCATE "Payment", "ClaimReminder", "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
  const versions: Record<string, string> = {};
  for (const name of ['plan-v1', 'ops-v1', 'plan-v2', 'ops-v2']) versions[name] = await publishRuleSet(db, read(`rules/electronics/${name}.json`));

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
  return { versions, decisions };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { decisions } = await seedDecisions(client);
    console.log(`seed:decisions: ${Object.keys(decisions).length} decisions`);
  } finally {
    await client.end();
  }
}
