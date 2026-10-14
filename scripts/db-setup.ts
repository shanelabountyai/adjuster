import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import pg from 'pg';

// One command from a fresh clone to a migrated local database (spec §13). Creates the dev and test databases,
// writes .env.local and .env.test if missing (both gitignored; values are local-only), and applies migrations.
// Never touches a file that exists, and never prints a value. Postgres must be running locally.
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; scripts: Record<string, string> };
const name = pkg.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
const port = /-p (\d+)/.exec(pkg.scripts['dev:template'] ?? pkg.scripts.dev ?? '')?.[1] ?? '4100';
// A Homebrew Postgres trusts the OS user. Set PGUSER/PGPASSWORD or LOCAL_PG_URL_BASE for anything else.
const base = process.env.LOCAL_PG_URL_BASE ?? `postgresql://${process.env.PGUSER ?? userInfo().username}${process.env.PGPASSWORD ? `:${process.env.PGPASSWORD}` : ''}@localhost:5432`;
const pool = '?connection_limit=10&pool_timeout=20'; // per-project cap on the shared max_connections

const targets = [
  { file: '.env.local', db: name, extra: ['DEMO_MODE=1'] },
  { file: '.env.test', db: `${name}_test`, extra: [], test: true },
];

async function ensureDb(dbName: string, test = false) {
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
    // A reseed is ~1,500 commits; with each waiting on an fsync, one disk stall on the laptop pushed it past the 20s hook timeout and
    // cascaded through decisions-verify (2026-10-14). A test database has nothing to lose in a crash, so commits do not wait.
    if (test) await admin.query(`ALTER DATABASE "${dbName}" SET synchronous_commit = off`);
  } finally {
    await admin.end();
  }
}

for (const t of targets) {
  const url = `${base}/${t.db}${pool}`;
  await ensureDb(t.db, t.test);
  if (!existsSync(t.file)) {
    writeFileSync(
      t.file,
      [`DATABASE_URL=${url}`, `DIRECT_URL=${url}`, `AUTH_SECRET=${randomBytes(32).toString('hex')}`, `APP_URL=http://localhost:${port}`, ...t.extra, ''].join('\n'),
    );
    console.log(`wrote ${t.file}`);
  }
  // .env.test first: dotenv-cli lets the first file win, so the test file's database beats .env.local's.
  const envFiles = t.file === '.env.test' ? '-e .env.test -e .env.local' : '-e .env.local';
  execSync(`npx dotenv ${envFiles} -- prisma migrate deploy`, { stdio: 'inherit' });
  console.log(`${t.db}: migrated`);
}
