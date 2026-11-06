import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { now } from '@/core/clock';
import { asSystem } from '@/core/db/rls';
import { env } from '@/core/env';
import { log } from '@/core/log';
import { safeEqual } from '@/core/tokens';
import { ENDED, isLive } from './provider';
import type { Prisma } from '@/generated/prisma/client';

// The Stripe webhook (INV-12), from SB's shape with its bug fixed. Stripe delivers at least once
// and retries a non-2xx for days, so:
// 1. Verify the raw body and the timestamp before anything else. The endpoint is public.
// 2. Claim the event id, then apply it and mark it processed IN ONE TRANSACTION, holding the
//    event row's lock. A delivery whose earlier apply threw finds `processedAt IS NULL` and applies
//    it (SB treated that retry as a duplicate and lost the event). A true duplicate is a no-op, and
//    two concurrent deliveries apply it once.
// 3. Acknowledge event types we don't handle, or Stripe retries them forever.

type Tx = Prisma.TransactionClient;
export type StripeEvent = { id: string; type: string; created: number; data: { object: unknown } };
type Subscription = {
  id: string;
  customer: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_end?: number; // moved onto the item in API 2025-03-31; read both
  items?: { data?: { current_period_end?: number; price?: { id: string; lookup_key?: string | null } }[] };
};

const TOLERANCE_S = 300; // Stripe's own default

/** `Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">[,v1=…]`. */
export function verifyStripeSignature(raw: string, header: string | null, secret: string, at = now()): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  if (!t || !/^\d+$/.test(t) || Math.abs(at.getTime() / 1000 - Number(t)) > TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && safeEqual(v ?? '', expected));
}

/** The org's billing state follows its subscription. The org id rides in subscription metadata (set at checkout). */
async function syncSubscription(tx: Tx, e: StripeEvent) {
  const sub = e.data.object as Subscription;
  const orgId = z.uuid().safeParse(sub.metadata?.orgId).data;
  if (typeof sub.id !== 'string') throw new Error('subscription event with no subscription id');
  if (!orgId || !(await tx.org.findUnique({ where: { id: orgId }, select: { id: true } }))) {
    // Deleted org or foreign subscription: acknowledge, don't retry. A live one is still charging
    // someone with nothing on our side to show for it (FR-05): that needs a person.
    log(isLive(sub.status) ? 'billing.unknown_org_live_subscription' : 'billing.unknown_org', { event: e.id, subscription: sub.id, status: sub.status });
    return;
  }
  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  // Stripe does not deliver in order. Only an event at least as new as the last one applied wins,
  // checked in the same statement so two events for one org cannot race past each other.
  // ponytail: `created` is whole seconds, so two events in one second resolve by arrival order; fetch the subscription from Stripe if that ever matters.
  // The org follows one subscription (FR-04): another's events apply only once the bound one has
  // ended, which is a re-subscribe. Until then they are a second, concurrent subscription.
  const applied = await tx.$executeRaw`
    INSERT INTO "BillingAccount" ("orgId", "stripeCustomerId", "stripeSubscriptionId", "plan", "status", "currentPeriodEnd", "stripeEventAt", "updatedAt")
    VALUES (${orgId}::uuid, ${sub.customer}, ${sub.id}, ${item?.price?.lookup_key ?? item?.price?.id ?? null}, ${sub.status},
            ${periodEnd ? new Date(periodEnd * 1000) : null}, ${new Date(e.created * 1000)}, ${now()})
    ON CONFLICT ("orgId") DO UPDATE SET
      "stripeCustomerId" = excluded."stripeCustomerId", "stripeSubscriptionId" = excluded."stripeSubscriptionId", "plan" = excluded."plan",
      "status" = excluded."status", "currentPeriodEnd" = excluded."currentPeriodEnd", "stripeEventAt" = excluded."stripeEventAt", "updatedAt" = excluded."updatedAt"
    WHERE ("BillingAccount"."stripeEventAt" IS NULL OR "BillingAccount"."stripeEventAt" <= excluded."stripeEventAt")
      AND ("BillingAccount"."stripeSubscriptionId" IS NULL OR "BillingAccount"."stripeSubscriptionId" = excluded."stripeSubscriptionId"
           OR "BillingAccount"."status" = ANY(${ENDED}))`;
  if (!applied) {
    const bound = await tx.billingAccount.findUnique({ where: { orgId }, select: { stripeSubscriptionId: true } });
    if (bound?.stripeSubscriptionId !== sub.id && isLive(sub.status)) {
      log('billing.second_subscription', { event: e.id, org: orgId, subscription: sub.id, bound: bound?.stripeSubscriptionId ?? null });
    }
  }
}

/** Event type → apply. Exported so tests can make one throw. A clone adds lines here. */
export const handlers: Record<string, (tx: Tx, e: StripeEvent) => Promise<void>> = {
  'customer.subscription.created': syncSubscription,
  'customer.subscription.updated': syncSubscription,
  'customer.subscription.deleted': syncSubscription,
};

type Reply = { status: number; body: Record<string, unknown> };

export async function receiveStripeWebhook(raw: string, signature: string | null, secret = env.STRIPE_WEBHOOK_SECRET): Promise<Reply> {
  if (!secret) return { status: 503, body: { error: 'webhooks_not_configured' } }; // fail closed (INV-11)
  if (!verifyStripeSignature(raw, signature, secret)) return { status: 400, body: { error: 'invalid_signature' } };
  let e: StripeEvent;
  try {
    e = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  if (typeof e?.id !== 'string' || typeof e.type !== 'string' || typeof e.created !== 'number') {
    return { status: 400, body: { error: 'invalid_event' } };
  }
  const payload = e as unknown as Prisma.InputJsonValue;

  try {
    // Cross-org (cross-org.ts): the event names its org, so the whole delivery runs as the system role.
    const applied = await asSystem((sys) => sys.$transaction(async (tx) => {
      await tx.stripeEvent.createMany({ data: [{ id: e.id, type: e.type, payload }], skipDuplicates: true });
      const [row] = await tx.$queryRaw<{ processedAt: Date | null }[]>`SELECT "processedAt" FROM "StripeEvent" WHERE "id" = ${e.id} FOR UPDATE`;
      if (row?.processedAt) return false;
      if (Object.hasOwn(handlers, e.type)) await handlers[e.type]!(tx, e);
      await tx.stripeEvent.update({ where: { id: e.id }, data: { processedAt: now(), error: null } });
      return true;
    }));
    return { status: 200, body: applied ? { received: true } : { received: true, duplicate: true } };
  } catch (err) {
    // The transaction rolled back, so the row is absent or still unprocessed: record why, and a 500
    // makes Stripe redeliver, which applies it.
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await asSystem((sys) => sys.stripeEvent.upsert({ where: { id: e.id }, create: { id: e.id, type: e.type, payload, error }, update: { error } }));
    log('billing.webhook_failed', { event: e.id, type: e.type });
    return { status: 500, body: { error: 'processing_failed' } };
  }
}
