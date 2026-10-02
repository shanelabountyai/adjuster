import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { publishRuleSet, recordDecision } from '@/adjudication/decisions';

// The clean seed for decisions:verify: plan-v1 and ops-v1 published, GC-01..GC-10 decided through the engine.
// Synthetic claims only. Replaces every rule set and decision in the target database.
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

type Db = Parameters<typeof publishRuleSet>[0];
export async function seedDecisions(db: Db) {
  await db.query('TRUNCATE "Decision", "RuleSetVersion"'); // row triggers do not fire on TRUNCATE
  const planId = await publishRuleSet(db, read('rules/electronics/plan-v1.json'));
  const opsId = await publishRuleSet(db, read('rules/electronics/ops-v1.json'));
  const decisions: Record<string, string> = {};
  for (let n = 1; n <= 10; n++) {
    const fx = read(`fixtures/gc/GC-${String(n).padStart(2, '0')}.json`);
    decisions[fx.id] = await recordDecision(db, { claimId: fx.id, planVersionId: planId, opsVersionId: opsId, snapshot: fx.facts, asOf: fx.asOf });
  }
  return { planId, opsId, decisions };
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
