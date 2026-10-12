import pg from 'pg';
import { runNoResponse } from '@/adjudication/no-response';

// claims:no-response: one run of the no-response job (task 3.6) on the date given. There is no default date: the
// job never reads the clock.
const i = process.argv.indexOf('--as-of');
const asOf = i > 0 ? process.argv[i + 1] : undefined;
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) {
  console.error('usage: claims:no-response --as-of YYYY-MM-DD');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { reminded, closed, skipped } = await runNoResponse(client, asOf!);
  for (const r of reminded) console.log(`REMINDER_${r.level} ${r.claimId}`);
  for (const id of closed) console.log(`CLOSED_NO_RESPONSE ${id}`);
  for (const id of skipped) console.log(`SKIPPED ${id}`);
  console.log(`claims:no-response: ${reminded.length} reminded, ${closed.length} closed, ${skipped.length} skipped on ${asOf}`);
} finally {
  await client.end();
}
