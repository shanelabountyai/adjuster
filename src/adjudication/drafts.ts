import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tierOf } from '@/adjudication/authority';
import { type Db, dictFile, loadVersions } from '@/adjudication/decisions';
import { OutOfAuthorityError } from '@/adjudication/documents';
import { powersOf } from '@/rules/authority';
import { canonicalJson, sha256Hex } from '@/rules/canonical';
import type { RuleSet } from '@/rules/schema';
import { opsInForce } from '@/rules/select';
import { checkDictionaryHash, type Issue, validateDictionary, validateRuleSet } from '@/rules/validate';

// Tasks 4.2 and 4.3 (D70, D77): the life of a version row. A draft is a copy of the latest published version of its
// kind and product, its author is whoever saved it last, and someone else publishes it. Each write carries its audit
// event in the same statement. Refusals are tested in D70's order: DRAFT_EXISTS, NOT_A_DRAFT, OUT_OF_AUTHORITY,
// PUBLISHER_IS_AUTHOR, DIFF_STALE, then DRAFT_INVALID, OPS_SAME_DAY and OPS_BACKDATED.

export class DraftError extends Error {
  constructor(
    readonly code: 'DRAFT_EXISTS' | 'NOT_A_DRAFT' | 'NO_PUBLISHED_VERSION' | 'PUBLISHER_IS_AUTHOR' | 'DIFF_STALE' | 'DRAFT_INVALID' | 'OPS_SAME_DAY' | 'OPS_BACKDATED',
    detail: string, readonly issues: Issue[] = []) {
    super(`${code}: ${detail}`);
  }
}
const notADraft = (id: string, status?: string) => new DraftError('NOT_A_DRAFT', `rule set version ${id} is ${status ?? 'not on file'}`);

// D66, D68: the power is ops rule data, read from the product's ops version in force on `asOf`.
// Returns the product's versions, which publishing reads again.
async function needPower(db: Db, product: string, userId: string, asOf: string, power: string, needed: string) {
  const versions = [...(await loadVersions(db)).values()].filter((v) => v.product === product);
  const tier = await tierOf(db, userId);
  if (!powersOf(opsInForce(versions, asOf)?.body.authority ?? [], tier).includes(power)) throw new OutOfAuthorityError(tier, ['power'], needed);
  return versions;
}

/** Starts the one open draft of a kind and product; returns its id. */
export async function createDraft(db: Db, d: { kind: 'plan' | 'ops'; product: string; userId: string; asOf: string }): Promise<string> {
  const what = `${d.product} ${d.kind}`;
  const { rows } = await db.query<{ id: string; version: number; status: string; body: RuleSet }>(
    `SELECT "id", "version", "status", "body" FROM "RuleSetVersion" WHERE "kind" = $1 AND "product" = $2 ORDER BY "version" DESC`, [d.kind, d.product]);
  const open = rows.find((r) => r.status === 'draft');
  if (open) throw new DraftError('DRAFT_EXISTS', `${what} v${open.version} is an open draft`);
  await needPower(db, d.product, d.userId, d.asOf, 'author_rules', `a draft of ${what}`);
  const base = rows.find((r) => r.status === 'published');
  if (!base) throw new DraftError('NO_PUBLISHED_VERSION', `${what} has no published version to copy; a product's first versions are loaded from files`);
  const version = rows[0]!.version + 1;
  try {
    const made = await db.query<{ id: string }>(
      `WITH made AS (
         INSERT INTO "RuleSetVersion" ("id", "kind", "product", "version", "status", "effectiveFrom", "body", "authoredBy", "basedOnId")
         VALUES (gen_random_uuid(), $1, $2, $3::int, 'draft', $4::date, $5::jsonb, $6::uuid, $7::uuid) RETURNING "id")
       INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
       SELECT $6::uuid, 'ruleset.draft_created', 'RuleSetVersion', "id"::text, $8::jsonb FROM made RETURNING "targetId" AS "id"`,
      [d.kind, d.product, version, base.body.effectiveFrom, { ...base.body, version }, d.userId, base.id,
        JSON.stringify({ kind: d.kind, product: d.product, version, basedOnId: base.id })]);
    return made.rows[0]!.id;
  } catch (e) {
    // two creates at once: the partial unique index (or the version key) refuses the second
    if ((e as { code?: string }).code === '23505') throw new DraftError('DRAFT_EXISTS', `${what} already has an open draft`);
    throw e;
  }
}

/**
 * Replaces a draft's body and returns what validation finds in it. An invalid body is stored all the same: a form
 * mid-edit is invalid, and only publishing needs a clean one. The row's kind, product, version and dictionary are not
 * the body's to change (D72), so they are written back over whatever the body says.
 */
export async function saveDraft(db: Db, d: { id: string; userId: string; body: Record<string, unknown>; asOf: string }): Promise<Issue[]> {
  const { rows: [row] } = await db.query<{ kind: string; product: string; version: number; status: string; body: RuleSet }>(
    `SELECT "kind", "product", "version", "status", "body" FROM "RuleSetVersion" WHERE "id" = $1::uuid`, [d.id]);
  if (row?.status !== 'draft') throw notADraft(d.id, row?.status);
  await needPower(db, row.product, d.userId, d.asOf, 'author_rules', `saving the draft of ${row.product} ${row.kind}`);

  const body: Record<string, unknown> = { ...d.body, kind: row.kind, product: row.product, version: row.version, factDictionary: row.body.factDictionary };
  const issues = validateRuleSet(body, validateDictionary(dictFile(row.body)).dict!);
  // The column follows the body's date once it is one; a calendar date Postgres will not take stays an error.
  const effectiveFrom = issues.some((i) => i.path === 'effectiveFrom') ? null : body.effectiveFrom;
  const saved = await db.query(
    `WITH saved AS (
       UPDATE "RuleSetVersion" SET "body" = $2::jsonb, "effectiveFrom" = coalesce($3::date, "effectiveFrom"), "authoredBy" = $4::uuid
       WHERE "id" = $1::uuid AND "status" = 'draft' RETURNING "id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $4::uuid, 'ruleset.draft_saved', 'RuleSetVersion', "id"::text, $5::jsonb FROM saved RETURNING "id"`,
    [d.id, JSON.stringify(body), effectiveFrom ?? null, d.userId, JSON.stringify({ issues: issues.map((i) => i.code) })]);
  if (!saved.rows[0]) throw notADraft(d.id, 'published'); // published between the read and the write
  return issues;
}

/**
 * Freezes a draft: content hash, `publishedAt` and `publishedBy` in one statement with the audit event. `diffHash` is
 * the content hash the publisher's impact diff ran on (D70). The statement names the body it read, so a save landing
 * between the read and the write publishes nothing.
 */
export async function publishDraft(db: Db, d: { id: string; userId: string; diffHash: string; asOf: string }): Promise<string> {
  const { rows: [row] } = await db.query<{ kind: string; product: string; version: number; status: string; body: RuleSet; authoredBy: string | null }>(
    `SELECT "kind", "product", "version", "status", "body", "authoredBy" FROM "RuleSetVersion" WHERE "id" = $1::uuid`, [d.id]);
  if (row?.status !== 'draft') throw notADraft(d.id, row?.status);
  const what = `${row.product} ${row.kind} v${row.version}`;
  const versions = await needPower(db, row.product, d.userId, d.asOf, 'publish_rules', `publishing ${what}`);
  if (row.authoredBy === d.userId) throw new DraftError('PUBLISHER_IS_AUTHOR', `${what} was last saved by its publisher`);
  const contentHash = sha256Hex(row.body);
  if (d.diffHash !== contentHash) throw new DraftError('DIFF_STALE', `${what} is ${contentHash}; the impact diff ran on ${d.diffHash}`);
  const dict = dictFile(row.body);
  const issues = [...validateRuleSet(row.body, validateDictionary(dict).dict!), ...checkDictionaryHash(row.body, dict)];
  if (issues.length) throw new DraftError('DRAFT_INVALID', `${what} has ${issues.length} validation issue(s): ${issues.map((i) => i.code).join(', ')}`, issues);
  // D77: selection takes the latest ops version effective on a day, so two from the same day would have no answer.
  // ponytail: a file loaded by publishRuleSet is not tested for this; it is the seed's loader
  const sameDay = versions.find((v) => row.kind === 'ops' && v.kind === 'ops' && v.status !== 'draft' && v.effectiveFrom === row.body.effectiveFrom);
  if (sameDay) throw new DraftError('OPS_SAME_DAY', `${what} takes effect on ${row.body.effectiveFrom}, as ops v${sameDay.version} does`);

  const body = JSON.stringify(row.body);
  const published = await db.query(
    `WITH published AS (
       UPDATE "RuleSetVersion" r SET "status" = 'published', "contentHash" = $2, "publishedAt" = now(), "publishedBy" = $3::uuid
       WHERE r."id" = $1::uuid AND r."status" = 'draft' AND r."body" = $4::jsonb AND (r."kind" <> 'ops' OR NOT EXISTS (
         SELECT 1 FROM "Decision" x JOIN "RuleSetVersion" o ON o."id" = x."opsVersionId"
         WHERE o."product" = r."product" AND x."asOf" >= r."effectiveFrom" AND o."effectiveFrom" <= r."effectiveFrom"))
       RETURNING r."id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $3::uuid, 'ruleset.published', 'RuleSetVersion', "id"::text, $5::jsonb FROM published RETURNING "id"`,
    [d.id, contentHash, d.userId, body, JSON.stringify({ contentHash, effectiveFrom: row.body.effectiveFrom })]);
  if (!published.rows[0]) {
    const { rows: [now] } = await db.query<{ status: string; same: boolean }>(`SELECT "status", "body" = $2::jsonb AS "same" FROM "RuleSetVersion" WHERE "id" = $1::uuid`, [d.id, body]);
    if (now?.status !== 'draft') throw notADraft(d.id, now?.status);
    if (!now.same) throw new DraftError('DIFF_STALE', `${what} was saved again while it was being published`);
    throw new DraftError('OPS_BACKDATED', `${what} from ${row.body.effectiveFrom} would replace the ops version of a stored decision`); // D44
  }
  return d.id;
}

/**
 * D69: a version published from the screen has no file until this writes one. Returns the path of every published
 * version with no file under `root`, written as canonical JSON when `write` is set. A file that is there and hashes
 * to something else is never overwritten.
 */
export async function exportRules(db: Db, o: { write: boolean; root?: string }): Promise<string[]> {
  const missing: string[] = [];
  for (const v of (await loadVersions(db)).values()) {
    if (v.status === 'draft') continue;
    const path = join(o.root ?? 'rules', v.product, `${v.kind}-v${v.version}.json`);
    if (!existsSync(path)) {
      if (o.write) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${canonicalJson(v.body)}\n`);
      }
      missing.push(path);
    } else if (sha256Hex(JSON.parse(readFileSync(path, 'utf8'))) !== v.contentHash) throw new Error(`RULE_FILE_MISMATCH: ${path} is not ${v.product} ${v.kind} v${v.version} as published (${v.contentHash})`);
  }
  return missing.sort();
}
