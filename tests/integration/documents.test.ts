import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import ev03 from '../../fixtures/ev/EV-03.json';
import { publishRuleSet } from '@/adjudication/decisions';
import { DocumentCorruptError, LocalDiskDocumentStore, readDocumentVersion, uploadDocument } from '@/adjudication/documents';

// Task 3.2 (D53): documents and their versions are rows that are only ever inserted, and the bytes are checked against the
// stored hash on every read. Raw SQL on its own connection for the database rules, as in adjudication-db.test.ts.

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const connected = client.connect();
let root: string;
let store: LocalDiskDocumentStore;
afterAll(() => client.end());
beforeEach(async () => {
  await connected;
  await client.query('TRUNCATE "ClaimFact", "DocumentReview", "DocumentWaiver", "DocumentVersion", "Document", "Decision", "Claim", "Contract", "RuleSetVersion"');
  // an upload's type is checked against the dictionary of the plan the claim's contract pins (task 3.3)
  const plan = await publishRuleSet(client, JSON.parse(readFileSync('rules/electronics/plan-v1.json', 'utf8')));
  await client.query(`INSERT INTO "Contract" ("id", "planVersionId", "facts") VALUES ('CT-1', $1, '{}')`, [plan]);
  await client.query(`INSERT INTO "Claim" ("id", "contractId", "facts") VALUES ('C-1', 'CT-1', '{}')`);
  root = await mkdtemp(join(tmpdir(), 'adjuster-docs-'));
  store = new LocalDiskDocumentStore(root);
  return () => rm(root, { recursive: true });
});

/** The constraint the database refused `sql` with, or 'accepted'. */
const run = async (sql: string, params: unknown[] = []) => {
  try {
    await client.query(sql, params);
    return 'accepted';
  } catch (e) {
    return (e as { constraint?: string }).constraint ?? String(e);
  }
};

const bytes = (s: string) => new TextEncoder().encode(s);
const upload = (type: string, content: string, claimId = 'C-1') =>
  uploadDocument(client, store, { claimId, type, bytes: bytes(content), source: 'claimant', uploadedBy: null });

describe('EV-03 an upload is a new version; nothing is overwritten or deleted', () => {
  it('numbers the fixture’s uploads as it does and keeps every one', async () => {
    const uploads = ev03.events.flatMap((e) => (e.action.type === 'upload' ? [e.action as { doc: string; version: string }] : []));
    expect(uploads.length).toBeGreaterThan(1);
    for (const [i, u] of uploads.entries()) {
      const v = await upload(u.doc, `scan ${i}`);
      expect(`${u.doc}/${v.version}`).toBe(u.version);
    }
    const { rows } = await client.query(`SELECT d."type", v."version" FROM "DocumentVersion" v JOIN "Document" d ON d."id" = v."documentId" ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.type}/${r.version}`)).toEqual(uploads.map((u) => u.version).sort());
    expect((await client.query(`SELECT 1 FROM "Document"`)).rows).toHaveLength(new Set(uploads.map((u) => u.doc)).size);
  });

  it('keeps the same bytes uploaded twice as two versions of one file', async () => {
    const [a, b] = [await upload('repairEstimate', 'same'), await upload('repairEstimate', 'same')];
    expect([a.version, b.version, a.sha256 === b.sha256, a.versionId === b.versionId]).toEqual([1, 2, true, false]);
    expect(await readdir(root)).toEqual([a.sha256]);
  });

  it('refuses UPDATE and DELETE of a document and of a version', async () => {
    const v = await upload('repairEstimate', 'x');
    expect(await run(`UPDATE "DocumentVersion" SET "sha256" = $2 WHERE "id" = $1`, [v.versionId, 'b'.repeat(64)])).toBe('document_append_only');
    expect(await run(`UPDATE "DocumentVersion" SET "source" = 'other' WHERE "id" = $1`, [v.versionId])).toBe('document_append_only');
    expect(await run(`DELETE FROM "DocumentVersion" WHERE "id" = $1`, [v.versionId])).toBe('document_append_only');
    expect(await run(`UPDATE "Document" SET "type" = 'other' WHERE "id" = $1`, [v.documentId])).toBe('document_append_only');
    expect(await run(`DELETE FROM "Document" WHERE "id" = $1`, [v.documentId])).toBe('document_append_only');
  });

  it('refuses a malformed hash, a version below 1, an empty source, a repeated version number and an unknown claim', async () => {
    const { documentId } = await upload('repairEstimate', 'x');
    const insert = (version: number, sha256: string, source = 'claimant') =>
      run(`INSERT INTO "DocumentVersion" ("id", "documentId", "version", "sha256", "source") VALUES (gen_random_uuid(), $1, $2, $3, $4)`, [documentId, version, sha256, source]);
    expect(await insert(2, 'A'.repeat(64))).toBe('document_version_sha256');
    expect(await insert(2, 'a'.repeat(63))).toBe('document_version_sha256');
    expect(await insert(0, 'a'.repeat(64))).toBe('document_version_number');
    expect(await insert(2, 'a'.repeat(64), '')).toBe('document_version_source');
    expect(await insert(2, 'a'.repeat(64), 'fax')).toBe('document_version_source');
    expect(await insert(1, 'a'.repeat(64))).toBe('DocumentVersion_documentId_version_key');
    await expect(upload('repairEstimate', 'x', 'C-none')).rejects.toThrow(/no contract on file/);
    expect(await run(`INSERT INTO "Document" ("id", "claimId", "type") VALUES (gen_random_uuid(), 'C-none', 'repairEstimate')`)).toBe('Document_claimId_fkey');
    expect((await client.query(`SELECT 1 FROM "DocumentVersion"`)).rows).toHaveLength(1);
  });
});

describe('DocumentStore: local disk, keyed by SHA-256, checked on read', () => {
  it('returns the bytes that were stored', async () => {
    const v = await upload('damagePhotos', 'pixels');
    expect(v.sha256).toBe(createHash('sha256').update('pixels').digest('hex'));
    expect(new TextDecoder().decode(await readDocumentVersion(client, store, v.versionId))).toBe('pixels');
  });

  it('refuses to return a file whose bytes no longer match the stored hash', async () => {
    const v = await upload('damagePhotos', 'pixels');
    await writeFile(join(root, v.sha256), 'edited');
    await expect(readDocumentVersion(client, store, v.versionId)).rejects.toBeInstanceOf(DocumentCorruptError);
    // Uploading the original bytes again neither rewrites the file nor records a version that points at the bad one.
    await expect(upload('damagePhotos', 'pixels')).rejects.toBeInstanceOf(DocumentCorruptError);
    expect((await client.query(`SELECT 1 FROM "DocumentVersion"`)).rows).toHaveLength(1);
  });

  it('takes nothing but a 64-hex key, and says so when a version or file is missing', async () => {
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/not a SHA-256/);
    await expect(store.get('a'.repeat(64))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readDocumentVersion(client, store, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(/not found/);
  });
});
