import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@/adjudication/decisions';

// Evidence documents (domain brief §8, D53). An upload is a new DocumentVersion row and nothing else changes: the
// database refuses UPDATE and DELETE on both tables. A version's status is not a column; it is read from the rows
// that exist (a later version supersedes), so there is nothing to edit.

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

/**
 * Stores the bytes, then records the next version of the claim's document of that type (creating the document on its
 * first upload) in one statement. Bytes first: a file with no row is harmless, a row with no file is not.
 */
export async function uploadDocument(db: Db, store: DocumentStore, u: Upload): Promise<UploadedVersion> {
  const sha256 = await store.put(u.bytes);
  const { rows } = await db.query<{ documentId: string; versionId: string; version: number }>(
    `WITH made AS (
       INSERT INTO "Document" ("id", "claimId", "type") VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT ("claimId", "type") DO NOTHING RETURNING "id"),
     doc AS (SELECT "id" FROM made UNION ALL SELECT "id" FROM "Document" WHERE "claimId" = $1 AND "type" = $2)
     INSERT INTO "DocumentVersion" ("id", "documentId", "version", "sha256", "source", "uploadedBy")
     SELECT gen_random_uuid(), doc."id", (SELECT coalesce(max("version"), 0) + 1 FROM "DocumentVersion" v WHERE v."documentId" = doc."id"),
       $3, $4, $5::uuid FROM doc
     RETURNING "documentId", "id" AS "versionId", "version"`,
    [u.claimId, u.type, sha256, u.source, u.uploadedBy]);
  return { ...rows[0]!, sha256 };
}

/** The bytes of one version, checked against the hash stored on its row. */
export async function readDocumentVersion(db: Db, store: DocumentStore, versionId: string): Promise<Uint8Array> {
  const { rows } = await db.query<{ sha256: string }>(`SELECT "sha256" FROM "DocumentVersion" WHERE "id" = $1`, [versionId]);
  if (!rows.length) throw new Error(`Document version ${versionId} not found`);
  return store.get(rows[0]!.sha256);
}
