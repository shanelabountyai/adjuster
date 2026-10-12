import { randomUUID } from 'node:crypto';
import { assignTier } from '@/adjudication/authority';
import type { Db } from '@/adjudication/decisions';

/** One new user per tier, assigned to it. The fixtures name a tier; the services take a user (D49). */
export async function staffAt<T extends string>(db: Db, tiers: readonly T[]): Promise<Record<T, string>> {
  const users = {} as Record<T, string>;
  for (const tier of tiers) await assignTier(db, { userId: (users[tier] = randomUUID()), tier, by: null });
  return users;
}
