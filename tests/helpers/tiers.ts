import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assignTier } from '@/adjudication/authority';
import type { Db } from '@/adjudication/decisions';

/** One new user per tier, assigned to it. The fixtures name a tier; the services take a user (D49). */
export async function staffAt<T extends string>(db: Db, tiers: readonly T[]): Promise<Record<T, string>> {
  const users = {} as Record<T, string>;
  for (const tier of tiers) await assignTier(db, { userId: (users[tier] = randomUUID()), tier, by: null });
  return users;
}

/** The template's resetDb empties every table, reference rows included; this puts back what the migration seeds, by its own statement. */
export const seedOverrideReasons = (db: Db) => db.query(readFileSync('prisma/migrations/20261012020000_override_authority/migration.sql', 'utf8')
  .match(/INSERT INTO "OverrideReason"[^;]+/)![0] + ' ON CONFLICT DO NOTHING');
