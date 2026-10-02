import pg from 'pg';
import { verifyDecisions } from '@/adjudication/decisions';

// decisions:verify (D6, P0-3): replays every stored decision from what it pinned. Prints OK, or one line per failure
// led by its code, and exits 1. `--as-of YYYY-MM-DD` limits it to decisions adjudicated on or before that date.
const i = process.argv.indexOf('--as-of');
const until = i > 0 ? process.argv[i + 1] : undefined;
if (i > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(until ?? '')) {
  console.error('usage: decisions:verify [--as-of YYYY-MM-DD]');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { checked, failures } = await verifyDecisions(client, until);
  for (const f of failures) console.error(`${f.code} ${f.id} ${f.detail}`);
  console.log(failures.length ? `decisions:verify: ${failures.length} failure(s) in ${checked} decision(s)` : `decisions:verify: OK (${checked} decisions)`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await client.end();
}
