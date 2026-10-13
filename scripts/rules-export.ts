import pg from 'pg';
import { exportRules } from '@/adjudication/drafts';

// rules:export (D69): writes every published version that has no file to rules/<product>/, to be committed.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const written = await exportRules(client, { write: true });
  for (const p of written) console.log(`rules:export: wrote ${p}`);
  console.log(`rules:export: ${written.length} file(s) written`);
} finally {
  await client.end();
}
