import { randomUUID } from 'node:crypto';
import { sendEmail } from '@/core/email/transport';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { asSystem } from '@/core/db/rls';
import { log } from '@/core/log';
import type { Prisma } from '@/generated/prisma/client';
import { sendSms } from './sms';
import { render } from './templates';

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1, 5, 30, 120].map((m) => m * 60_000); // after attempt 1..4; then it stays failed

export type Enqueue = { channel: 'email' | 'sms'; to: string; template: string; data?: Record<string, unknown>; orgId?: string; sendAfter?: Date };

/** Queue a message. Pass `tx` to enqueue inside the caller's transaction so the two commit together. */
export async function enqueue(m: Enqueue, tx: Pick<typeof db, 'outbox'> = db) {
  render(m.template, m.data); // fail at the call site on a typo, not silently at drain time
  // createMany with our own id, not create: RETURNING must pass the SELECT policy, which a row for another org
  // (or none) does not under RLS. Insert is open on Outbox; reading it is scoped (addendum §2).
  const id = randomUUID();
  await tx.outbox.createMany({ data: [{ ...m, id, data: (m.data ?? {}) as Prisma.InputJsonObject }] });
  return { id };
}

/** How long a claimed row stays invisible to other drains; must outlast the transports' 15s fetch timeout. */
export const LEASE_MS = 2 * 60_000;

/**
 * Sends due messages. Each row is claimed in a short transaction (FOR UPDATE SKIP LOCKED) that counts
 * the attempt and leases the row by pushing `sendAfter` out, so overlapping drains never take it.
 * The send runs outside any transaction (FR-01: a send slower than the 5s tx timeout was delivered
 * but never recorded, then re-sent every run). Delivery is at-least-once: a crash after the provider
 * accepts sends it again once the lease runs out. A failure backs the row off; after MAX_ATTEMPTS it
 * stays unsent with `lastError` for a human.
 */
// Cross-org (cross-org.ts): cron drains and sweeps every org's rows as the system role.
export function drainOutbox(limit = 25): Promise<{ sent: number; failed: number }> {
  return asSystem(async (sys) => {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const row = await sys.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<{ id: string; channel: string; to: string; template: string; data: unknown; attempts: number }[]>`
          SELECT id, channel, "to", template, data, attempts FROM "Outbox"
          WHERE "sentAt" IS NULL AND "sendAfter" <= ${now()} AND attempts < ${MAX_ATTEMPTS}
          ORDER BY "sendAfter" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (r) await tx.outbox.update({ where: { id: r.id }, data: { attempts: { increment: 1 }, sendAfter: new Date(now().getTime() + LEASE_MS) } });
        return r;
      });
      if (!row) break;
      const attempts = row.attempts + 1;
      try {
        const { subject, body } = render(row.template, row.data);
        if (row.channel === 'sms') await sendSms({ to: row.to, body });
        else await sendEmail({ to: row.to, subject, body });
      } catch (err) {
        // Error text can echo provider detail but never our body or address: sendEmail/sendSms throw status-only messages.
        await sys.outbox.update({
          where: { id: row.id },
          data: { lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500), sendAfter: new Date(now().getTime() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1)!)) },
        });
        log('outbox.failed', { id: row.id, attempts });
        failed++;
        continue;
      }
      await sys.outbox.update({ where: { id: row.id }, data: { sentAt: now(), lastError: null } });
      sent++;
    }
    return { sent, failed };
  });
}

/** Old sent rows carry addresses and payloads; nothing reads them after a week. */
export async function sweepOutbox(): Promise<number> {
  const { count } = await asSystem((sys) => sys.outbox.deleteMany({ where: { sentAt: { lt: new Date(now().getTime() - 7 * 86_400_000) } } }));
  return count;
}
