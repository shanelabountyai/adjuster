import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { publishRuleSet } from '@/adjudication/decisions';
import { adjudicateClaim } from '@/adjudication/pipeline';

// The clean seed for decisions:verify (task 2.11): both plan and both ops versions published, then every claim filed
// as a contract and a claim and decided by the pipeline, which picks the versions. GC-01..10 and 12..14, the RV-01
// pair (one loss under a plan-v1 and a plan-v2 contract), and GC-01's claim on the last day of ops-v1 and the first
// of ops-v2. Synthetic claims only. Replaces every rule set, contract, claim and decision in the target database.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const onContract = ([k]: [string, unknown]) => k.startsWith('contract.') || k.startsWith('product.');

type Db = Parameters<typeof publishRuleSet>[0];
export async function seedDecisions(db: Db) {
  await db.query('TRUNCATE "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
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
    const facts = Object.entries(c.facts);
    await db.query('INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ($1, $2, $3)',
      [`CT-${c.id}`, versions[c.plan], Object.fromEntries(facts.filter(onContract))]);
    await db.query('INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ($1, $2, $3)',
      [c.id, `CT-${c.id}`, Object.fromEntries(facts.filter((e) => !onContract(e)))]);
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
