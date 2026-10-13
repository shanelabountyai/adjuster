import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Db, dictFile, loadVersions } from '@/adjudication/decisions';
import { tierOf } from '@/adjudication/authority';
import { paidCents } from '@/adjudication/payments';
import { checkAuthority } from '@/rules/authority';
import type { FactValue } from '@/rules/evaluate';
import { selectVersions } from '@/rules/select';

// Evidence documents (domain brief §8, D53). An upload is a new DocumentVersion row and nothing else changes: the
// database refuses UPDATE and DELETE on both tables. A version's status is not a column; it is read from the rows
// that exist (a later version supersedes), so there is nothing to edit. Reviews and the waiver are rows too (task 3.3,
// D54), a status moves only along MOVES, and every move appends its audit event in the statement that makes it.

export type DocStatus = 'requested' | 'received' | 'accepted' | 'rejected' | 'superseded' | 'waived';
export type DocAction = 'upload' | 'accept' | 'reject' | 'waive';
type Review = 'accepted' | 'rejected';

// EV-06: the status of a claim's document of one type, the action, and the status it leaves. `superseded` is only ever
// a version's status; it is here so that reviewing an old version has a name to be refused under.
const MOVES: Record<DocStatus, Partial<Record<DocAction, DocStatus>>> = {
  requested: { upload: 'received', waive: 'waived' },
  received: { upload: 'received', accept: 'accepted', reject: 'rejected', waive: 'waived' },
  rejected: { upload: 'received', waive: 'waived' },
  accepted: { upload: 'received' },
  superseded: {},
  waived: {},
};

export class IllegalDocumentMoveError extends Error {
  readonly code = 'ILLEGAL_DOCUMENT_MOVE';
  constructor(readonly from: string, readonly action: string) {
    super(`Illegal document move: ${action} on a ${from} document`);
  }
}

export class OutOfAuthorityError extends Error {
  readonly code = 'OUT_OF_AUTHORITY';
  constructor(readonly tier: string | null, readonly lacks: string[], needed: string) {
    super(`${tier ? `Tier ${tier}` : 'A user with no tier'} lacks ${lacks.join(' and ')} for ${needed}`);
  }
}

/** The status `action` leaves a document in, or throws if the table has no such move. */
export function assertDocumentMove(from: DocStatus, action: DocAction): DocStatus {
  const to = MOVES[from]?.[action];
  if (!to) throw new IllegalDocumentMoveError(from, action);
  return to;
}

/**
 * Status from rows (D51b, D53). A version is superseded once a later one exists, otherwise what its review said,
 * otherwise received. The document is waived if waived, else its latest version's status, else requested.
 */
export function documentStatus(versions: readonly { version: number; review: Review | null }[], waived: boolean): { status: DocStatus; versions: Record<number, DocStatus> } {
  const last = Math.max(...versions.map((v) => v.version));
  const each = Object.fromEntries(versions.map((v) => [v.version, v.version < last ? 'superseded' : v.review ?? 'received'])) as Record<number, DocStatus>;
  return { status: waived ? 'waived' : each[last] ?? 'requested', versions: each };
}

export class DocumentCorruptError extends Error {
  readonly code = 'DOCUMENT_CORRUPT';
  constructor(readonly sha256: string, readonly actual: string) {
    super(`Stored document ${sha256} now hashes to ${actual}`);
  }
}

/** Where the bytes live. The key is the SHA-256 of the content, so a read can always be checked against it. */
export interface DocumentStore {
  /** Stores the bytes and returns their SHA-256 (lowercase hex). Never overwrites. */
  put(bytes: Uint8Array): Promise<string>;
  /** Returns the bytes, or throws `DocumentCorruptError` if they no longer hash to `sha256`. */
  get(sha256: string): Promise<Uint8Array>;
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class LocalDiskDocumentStore implements DocumentStore {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    const sha256 = sha256Of(bytes);
    await mkdir(this.root, { recursive: true });
    try {
      await writeFile(join(this.root, sha256), bytes, { flag: 'wx' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      await this.get(sha256); // same content already stored: fine if it is still intact, an error if it is not
    }
    return sha256;
  }

  async get(sha256: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${JSON.stringify(sha256)} is not a SHA-256`); // the key becomes a path
    const bytes = await readFile(join(this.root, sha256));
    const actual = sha256Of(bytes);
    if (actual !== sha256) throw new DocumentCorruptError(sha256, actual);
    return bytes;
  }
}

export type Upload = { claimId: string; type: string; bytes: Uint8Array; source: string; uploadedBy: string | null };
export type UploadedVersion = { documentId: string; versionId: string; version: number; sha256: string };

/** The claim's contract and the rule-set versions of its product. The document types are the `docs.<type>` facts its plan's dictionary names. */
async function rulesFor(db: Db, claimId: string) {
  const versions = [...(await loadVersions(db)).values()];
  const pin = (await db.query<{ planVersionId: string; facts: Record<string, unknown> }>(
    `SELECT k."planVersionId", k."facts" FROM "Claim" c JOIN "Contract" k ON k."id" = c."contractId" WHERE c."id" = $1`, [claimId])).rows[0];
  const plan = versions.find((v) => v.id === pin?.planVersionId);
  if (!pin || !plan) throw new Error(`Claim ${claimId} has no contract on file, so no document types`);
  const facts = dictFile(plan.body).facts as DictFact[];
  const types = facts.flatMap((f) => (f.id.startsWith('docs.') ? [f.id.slice(5)] : []));
  return { pin, types, facts, versions: versions.filter((v) => v.product === plan.product) };
}

type DictFact = { id: string; type: string; source: string; values?: string[] };
const VALUE_OK: Record<string, (v: unknown, f: DictFact) => boolean> = {
  bool: (v) => typeof v === 'boolean',
  int: Number.isSafeInteger, cents: Number.isSafeInteger, bps: Number.isSafeInteger,
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  string: (v) => typeof v === 'string',
  enum: (v, f) => typeof v === 'string' && (f.values ?? []).includes(v),
};

/**
 * Throws unless a person may enter each of these on the claim: an input fact of the plan's dictionary that is not a
 * document status (read from rows), not a list, and not a fact the contract already states; with a value of its type.
 */
function assertEnterable(r: { facts: DictFact[]; pin: { facts: Record<string, unknown> } }, entered: Record<string, unknown>) {
  for (const [id, value] of Object.entries(entered)) {
    const f = r.facts.find((x) => x.id === id);
    const ok = f && VALUE_OK[f.type];
    if (!f || !ok || f.source !== 'input' || id.startsWith('docs.') || id in r.pin.facts) throw new Error(`${JSON.stringify(id)} is not a fact a person enters on this claim`);
    if (!ok(value, f)) throw new Error(`${id} takes a ${f.type}, not ${JSON.stringify(value)}`);
  }
}

type Statuses = { docs: Record<string, DocStatus>; versions: Record<string, DocStatus> };

/** Every document type's status for a claim, and every version's, keyed `type/version` as the fixtures have them. */
export async function readDocumentStatuses(db: Db, claimId: string): Promise<Statuses> {
  return statusesOf(db, claimId, (await rulesFor(db, claimId)).types);
}

async function statusesOf(db: Db, claimId: string, types: string[]): Promise<Statuses> {
  const { rows } = await db.query<{ type: string; version: number; review: Review | null }>(
    `SELECT d."type", v."version", r."result" AS "review" FROM "Document" d JOIN "DocumentVersion" v ON v."documentId" = d."id"
     LEFT JOIN "DocumentReview" r ON r."versionId" = v."id" WHERE d."claimId" = $1`, [claimId]);
  const waived = new Set((await db.query<{ type: string }>(`SELECT "type" FROM "DocumentWaiver" WHERE "claimId" = $1`, [claimId])).rows.map((w) => w.type));
  const out: Statuses = { docs: {}, versions: {} };
  for (const type of types) {
    const s = documentStatus(rows.filter((r) => r.type === type), waived.has(type));
    out.docs[type] = s.status;
    for (const [n, status] of Object.entries(s.versions)) out.versions[`${type}/${n}`] = status;
  }
  return out;
}

/** The document's current status and the status `action` leaves it in; throws on an unknown type or an illegal move. */
async function move(db: Db, claimId: string, type: string, action: DocAction, types: string[]) {
  if (!types.includes(type)) throw new Error(`${JSON.stringify(type)} is not a document type of claim ${claimId}'s plan`);
  const from = (await statusesOf(db, claimId, types)).docs[type]!;
  return { from, to: assertDocumentMove(from, action) };
}

const gone = (what: string, from: string) => new Error(`${what} left ${from} before it could move`);

/**
 * Stores the bytes, then records the next version of the claim's document of that type (creating the document on its
 * first upload) and the audit event in one statement. Bytes first: a file with no row is harmless, a row with no file is not.
 */
export async function uploadDocument(db: Db, store: DocumentStore, u: Upload): Promise<UploadedVersion> {
  const { from, to } = await move(db, u.claimId, u.type, 'upload', (await rulesFor(db, u.claimId)).types);
  const sha256 = await store.put(u.bytes);
  const { rows } = await db.query<{ documentId: string; versionId: string; version: number }>(
    `WITH made AS (
       INSERT INTO "Document" ("id", "claimId", "type") VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT ("claimId", "type") DO NOTHING RETURNING "id"),
     doc AS (SELECT "id" FROM made UNION ALL SELECT "id" FROM "Document" WHERE "claimId" = $1 AND "type" = $2),
     ver AS (
       INSERT INTO "DocumentVersion" ("id", "documentId", "version", "sha256", "source", "uploadedBy")
       SELECT gen_random_uuid(), doc."id", (SELECT coalesce(max("version"), 0) + 1 FROM "DocumentVersion" v WHERE v."documentId" = doc."id"),
         $3, $4, $5::uuid FROM doc
       WHERE NOT EXISTS (SELECT 1 FROM "DocumentWaiver" w WHERE w."claimId" = $1 AND w."type" = $2)
       RETURNING "documentId", "id" AS "versionId", "version"),
     audit AS (
       INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
       SELECT $5::uuid, 'document.uploaded', 'Claim', $1, jsonb_build_object('version', "version", 'versionId', "versionId") || $6::jsonb FROM ver)
     SELECT * FROM ver`,
    [u.claimId, u.type, sha256, u.source, u.uploadedBy, JSON.stringify({ type: u.type, from, to, source: u.source })]);
  if (!rows[0]) throw gone(`Claim ${u.claimId}'s ${u.type}`, from);
  return { ...rows[0], sha256 };
}

/**
 * Accepts or rejects one version, once, with the audit event in the same statement. This is the document's move only:
 * an acceptance that should decide the claim goes through the pipeline's `acceptEvidence` (D56). Only the latest version of a
 * document that is not waived is `received`; the insert holds that again, so a version superseded in between is not reviewed.
 */
export async function reviewDocument(db: Db, r: { versionId: string; result: Review; reason?: string | null; userId: string | null; facts?: Record<string, unknown> }): Promise<{ claimId: string }> {
  const v = (await db.query<{ claimId: string; type: string; version: number }>(
    `SELECT d."claimId", d."type", v."version" FROM "DocumentVersion" v JOIN "Document" d ON d."id" = v."documentId" WHERE v."id" = $1`, [r.versionId])).rows[0];
  if (!v) throw new Error(`Document version ${r.versionId} not found`);
  const action = r.result === 'accepted' ? 'accept' : 'reject';
  const rules = await rulesFor(db, v.claimId);
  const { types } = rules;
  // D55: the facts read from a document are entered when it is accepted, in the statement that accepts it.
  const facts = r.facts ?? {};
  if (r.result === 'rejected' && Object.keys(facts).length) throw new Error(`No fact is entered from a rejected document (version ${r.versionId})`);
  assertEnterable(rules, facts);
  const now = await statusesOf(db, v.claimId, types);
  // An old version is refused under its own status; the latest one's status is the document's, waiver included.
  const from = now.versions[`${v.type}/${v.version}`] === 'superseded' ? 'superseded' : now.docs[v.type] ?? 'superseded';
  const to = assertDocumentMove(from, action);
  const { rows } = await db.query(
    `WITH made AS (
       INSERT INTO "DocumentReview" ("id", "versionId", "result", "reasonCode", "reviewedBy")
       SELECT gen_random_uuid(), v."id", $2, $3, $4::uuid FROM "DocumentVersion" v JOIN "Document" d ON d."id" = v."documentId"
       WHERE v."id" = $1 AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" n WHERE n."documentId" = v."documentId" AND n."version" > v."version")
         AND NOT EXISTS (SELECT 1 FROM "DocumentWaiver" w WHERE w."claimId" = d."claimId" AND w."type" = d."type")
       RETURNING "id"),
     entered AS (
       INSERT INTO "ClaimFact" ("id", "claimId", "factId", "value", "documentVersionId", "enteredBy")
       SELECT gen_random_uuid(), $6, e.key, e.value, $1, $4::uuid FROM made, jsonb_each($8::jsonb) e)
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $4::uuid, $5, 'Claim', $6, $7::jsonb FROM made RETURNING "id"`,
    [r.versionId, r.result, r.reason ?? null, r.userId, `document.${r.result}`, v.claimId,
      JSON.stringify({ type: v.type, version: v.version, versionId: r.versionId, from, to, ...(r.reason ? { reason: r.reason } : {}), ...(r.facts ? { facts } : {}) }),
      JSON.stringify(facts)]);
  if (!rows.length) throw gone(`Document version ${r.versionId}`, from);
  return { claimId: v.claimId };
}

export type Waiver = { claimId: string; type: string; reasonText: string; asOf: string; userId: string | null };

/**
 * Waives a claim's document of one type, with the audit event in the same statement. The user's tier is read from
 * the assignment table (D49) and must hold the `waive_documents` power under the ops version in force on `asOf`; both
 * are stored on the row. A waiver needs no upload and is final. The document's move only: `waiveEvidence` also
 * decides the claim (D56).
 * A waiver approves no money, so its total incurred is what the claim has been paid (D50, D60).
 */
export async function waiveDocument(db: Db, w: Waiver): Promise<void> {
  const { pin, types, versions } = await rulesFor(db, w.claimId);
  const { from, to } = await move(db, w.claimId, w.type, 'waive', types);
  const selected = selectVersions({ planVersion: pin.planVersionId }, versions.map((v) => ({ ...v, name: v.id })), w.asOf);
  if ('error' in selected) throw new Error(`${selected.error}: ${selected.kind} on ${w.asOf}`);
  const tier = await tierOf(db, w.userId);
  const check = checkAuthority(selected.ops.body.authority ?? [], tier, 'waive_documents', await paidCents(db, w.claimId), 0);
  if (!check.allowed) throw new OutOfAuthorityError(tier, check.lacks, 'waive_documents');
  const { rows } = await db.query(
    `WITH made AS (
       INSERT INTO "DocumentWaiver" ("id", "claimId", "type", "reasonText", "tier", "asOf", "waivedBy")
       SELECT gen_random_uuid(), $1, $2, $3, $4, $5::date, $6::uuid
       WHERE NOT EXISTS (SELECT 1 FROM "DocumentWaiver" w WHERE w."claimId" = $1 AND w."type" = $2)
         AND NOT EXISTS (SELECT 1 FROM "Document" d JOIN "DocumentVersion" v ON v."documentId" = d."id" JOIN "DocumentReview" r ON r."versionId" = v."id"
           WHERE d."claimId" = $1 AND d."type" = $2 AND r."result" = 'accepted'
             AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" n WHERE n."documentId" = v."documentId" AND n."version" > v."version"))
       RETURNING "id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $6::uuid, 'document.waived', 'Claim', $1, $7::jsonb FROM made RETURNING "id"`,
    [w.claimId, w.type, w.reasonText, tier, w.asOf, w.userId, JSON.stringify({ type: w.type, from, to, reasonText: w.reasonText, tier, asOf: w.asOf })]);
  if (!rows.length) throw gone(`Claim ${w.claimId}'s ${w.type}`, from);
}

/** The bytes of one version, checked against the hash stored on its row. */
export async function readDocumentVersion(db: Db, store: DocumentStore, versionId: string): Promise<Uint8Array> {
  const { rows } = await db.query<{ sha256: string }>(`SELECT "sha256" FROM "DocumentVersion" WHERE "id" = $1`, [versionId]);
  if (!rows.length) throw new Error(`Document version ${versionId} not found`);
  return store.get(rows[0]!.sha256);
}

/**
 * Enters a fact no document carries (D55), on the word of the person named, with the audit event in the same
 * statement. Nothing is edited: entering the fact again is a later row, and the latest one counts.
 */
export async function enterFact(db: Db, f: { claimId: string; factId: string; value: unknown; userId: string }): Promise<void> {
  assertEnterable(await rulesFor(db, f.claimId), { [f.factId]: f.value });
  await db.query(
    `WITH made AS (
       INSERT INTO "ClaimFact" ("id", "claimId", "factId", "value", "enteredBy") VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4::uuid) RETURNING "id")
     INSERT INTO "AuditEvent" ("actorUserId", "action", "targetType", "targetId", "data")
     SELECT $4::uuid, 'fact.entered', 'Claim', $1, $5::jsonb FROM made`,
    [f.claimId, f.factId, JSON.stringify(f.value), f.userId, JSON.stringify({ factId: f.factId, value: f.value })]);
}

/**
 * What the claim's evidence says now (D47, D51c, D55): the ids of its accepted document versions, sorted, and every
 * entered fact that counts. A document's facts count only while its version is accepted (a later upload supersedes
 * it, facts and all); a fact entered without a document always counts. Later entries win.
 */
export async function readEvidence(db: Db, claimId: string): Promise<{ facts: Record<string, FactValue>; documentVersions: string[] }> {
  const accepted = `SELECT v."id" FROM "Document" d JOIN "DocumentVersion" v ON v."documentId" = d."id" JOIN "DocumentReview" r ON r."versionId" = v."id"
     WHERE d."claimId" = $1 AND r."result" = 'accepted'
       AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" n WHERE n."documentId" = v."documentId" AND n."version" > v."version")`;
  const documentVersions = (await db.query<{ id: string }>(accepted, [claimId])).rows.map((r) => r.id).sort();
  const { rows } = await db.query<{ factId: string; value: FactValue }>(
    `SELECT "factId", "value" FROM "ClaimFact" WHERE "claimId" = $1 AND ("documentVersionId" IS NULL OR "documentVersionId" IN (${accepted}))
     ORDER BY "enteredAt", "id"`, [claimId]);
  return { facts: Object.fromEntries(rows.map((r) => [r.factId, r.value])), documentVersions };
}
