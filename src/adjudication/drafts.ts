import { tierOf } from '@/adjudication/authority';
import { type Db, dictFile, loadVersions } from '@/adjudication/decisions';
import { OutOfAuthorityError } from '@/adjudication/documents';
import { powersOf } from '@/rules/authority';
import type { RuleSet } from '@/rules/schema';
import { opsInForce } from '@/rules/select';
import { type Issue, validateDictionary, validateRuleSet } from '@/rules/validate';

// Task 4.2 (D70): the draft half of a version row's life. A draft is a copy of the latest published version of its
// kind and product, and its author is whoever saved it last. Each write carries its audit event in the same statement.
// Refusals are tested in D70's order: DRAFT_EXISTS, NOT_A_DRAFT, OUT_OF_AUTHORITY. Publishing a draft is 4.3.

export class DraftError extends Error {
  constructor(readonly code: 'DRAFT_EXISTS' | 'NOT_A_DRAFT' | 'NO_PUBLISHED_VERSION', detail: string) {
    super(`${code}: ${detail}`);
  }
}

// D66, D68: the power is ops rule data, read from the product's ops version in force on `asOf`.
async function needPower(db: Db, product: string, userId: string, asOf: string, needed: string) {
  const ops = opsInForce([...(await loadVersions(db)).values()].filter((v) => v.product === product), asOf);
  const tier = await tierOf(db, userId);
  if (!powersOf(ops?.body.authority ?? [], tier).includes('author_rules')) throw new OutOfAuthorityError(tier, ['power'], needed);
}

/** Starts the one open draft of a kind and product; returns its id. */
export async function createDraft(db: Db, d: { kind: 'plan' | 'ops'; product: string; userId: string; asOf: string }): Promise<string> {
  const what = `${d.product} ${d.kind}`;
  const { rows } = await db.query<{ id: string; version: number; status: string; body: RuleSet }>(
    `SELECT "id", "version", "status", "body" FROM "RuleSetVersion" WHERE "kind" = $1 AND "product" = $2 ORDER BY "version" DESC`, [d.kind, d.product]);
  const open = rows.find((r) => r.status === 'draft');
  if (open) throw new DraftError('DRAFT_EXISTS', `${what} v${open.version} is an open draft`);
  await needPower(db, d.product, d.userId, d.asOf, `a draft of ${what}`);
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
  const notADraft = () => new DraftError('NOT_A_DRAFT', `rule set version ${d.id} is ${row?.status ?? 'not on file'}`);
  if (row?.status !== 'draft') throw notADraft();
  await needPower(db, row.product, d.userId, d.asOf, `saving the draft of ${row.product} ${row.kind}`);

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
  if (!saved.rows[0]) throw notADraft(); // published between the read and the write
  return issues;
}
