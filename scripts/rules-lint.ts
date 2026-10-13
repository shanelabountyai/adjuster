import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { exportRules } from '@/adjudication/drafts';
import { checkDictionaryHash, validateDictionary, validateRuleSet, type Issue } from '@/rules/validate';

// `npm run rules:lint` (CLAUDE.md): schema-validate rules/, then grep src/ for plan identifiers and escape hatches.
// Plan identifiers are read from the fact dictionary (planIdentifier: true), so no plan name lives in this script either.

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
let failed = 0;
const fail = (where: string, msg: string) => { failed++; console.error(`rules:lint: FAIL ${where}: ${msg}`); };
const report = (where: string, issues: Issue[]) => issues.forEach((i) => fail(`${where} ${i.path}`, `${i.code} ${i.message}`));

const identifiers = new Set<string>();
for (const dir of readdirSync('rules')) {
  const files = readdirSync(join('rules', dir));
  const dicts = new Map<string, { dict: NonNullable<ReturnType<typeof validateDictionary>['dict']>; raw: unknown }>();
  for (const f of files.filter((n) => n.startsWith('facts-'))) {
    const raw = json(join('rules', dir, f));
    const { dict, issues } = validateDictionary(raw);
    report(`rules/${dir}/${f}`, issues);
    if (dict) {
      dicts.set(dict.id, { dict, raw });
      dict.facts.filter((x) => x.planIdentifier).forEach((x) => x.values?.forEach((v) => identifiers.add(v)));
    }
  }
  for (const f of files.filter((n) => /^(plan|ops)-/.test(n))) {
    const doc = json(join('rules', dir, f));
    const d = dicts.get(doc.factDictionary);
    if (!d) fail(`rules/${dir}/${f}`, `fact dictionary ${doc.factDictionary} not found`);
    else report(`rules/${dir}/${f}`, [...validateRuleSet(doc, d.dict), ...checkDictionaryHash(doc, d.raw)]);
  }
}

// Non-negotiables 1 and 2: no plan identifiers anywhere under src/, no eval/Function/dynamic import in the rule path.
// src/generated is Prisma output; the dynamic-import check is scoped to the code this project owns.
// src/core is template-owned and never edited here (CLAUDE.md), so a hit there (a '+' alias in link.ts) is not product logic.
const src = walk('src').filter((p) => /\.(ts|tsx|js|mjs)$/.test(p) && !/^src\/(generated|core)\//.test(p));
for (const p of src) {
  const text = readFileSync(p, 'utf8');
  for (const id of identifiers) if (new RegExp(`\\b${id}\\b`, 'i').test(text)) fail(p, `plan identifier "${id}" in src/`);
  if (/^src\/(rules|engine)\//.test(p) && /\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(/.test(text)) fail(p, 'eval, Function or dynamic import in the rule path');
}

// D69: `--db` (npm run rules:lint:db) also fails on a published version with no file. CI never runs this form.
if (process.argv.includes('--db')) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const p of await exportRules(client, { write: false })) fail(p, 'a published version has no file; run rules:export and commit it');
  } catch (e) { fail('rules/', (e as Error).message); } finally { await client.end(); }
}

if (failed) { console.error(`rules:lint: ${failed} problem(s)`); process.exit(1); }
console.log(`rules:lint: ok (${identifiers.size} plan identifiers checked against ${src.length} src files)`);
