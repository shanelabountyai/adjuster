import pg from 'pg';
import { env } from '@/core/env';
import { assertLocalOrAllowed } from '@/core/db/local-guard';
import type { Db } from './decisions';

assertLocalOrAllowed(env.DATABASE_URL, process.env);

// The services take a `Db` in pg's query shape, as the scripts and tests pass them; the pages share this one.
// Reused across dev hot reloads, as `@/core/db` is. ponytail: max 2, the pages only save and start drafts; raise it if they queue.
const g = globalThis as unknown as { servicePool?: pg.Pool };
export const pool: Db = (g.servicePool ??= new pg.Pool({ connectionString: env.DATABASE_URL, max: 2, options: '-c timezone=UTC' }));
