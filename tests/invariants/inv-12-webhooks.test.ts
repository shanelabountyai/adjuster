import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts parses process.env at import; the demo case at the bottom needs a demo session to resolve.
vi.hoisted(() => { process.env.DEMO_MODE = '1'; });

import { demoSignIn } from '@/core/auth/demo';
import { SESSION_COOKIE } from '@/core/auth/session';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { mockProvider, stripeProvider } from '@/modules/billing/provider';
import { destroyOrg } from '@/app/o/[org]/settings/danger/actions';
import { openPortal, startCheckout } from '@/app/o/[org]/settings/billing/actions';
import { handlers, receiveStripeWebhook, type StripeEvent } from '@/modules/billing/webhook';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { jar } from '../helpers/next';
import { seedDemo } from '../../scripts/seed-demo';

beforeEach(resetAuthTables);
afterEach(() => vi.restoreAllMocks());

const SECRET = 'whsec_test_secret';
const sign = (raw: string, t = Math.floor(now().getTime() / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;

let seq = 0;
const subEvent = (orgId: string, o: { status?: string; price?: string; created?: number; type?: string; id?: string; sub?: string } = {}): StripeEvent => ({
  id: o.id ?? `evt_${++seq}`,
  type: o.type ?? 'customer.subscription.updated',
  created: o.created ?? 1_800_000_000,
  data: {
    object: {
      id: o.sub ?? 'sub_1',
      customer: 'cus_1',
      status: o.status ?? 'active',
      metadata: { orgId },
      items: { data: [{ current_period_end: 1_802_000_000, price: { id: o.price ?? 'price_pro' } }] },
    },
  },
});
const deliver = (e: StripeEvent | string, sig?: string) => {
  const raw = typeof e === 'string' ? e : JSON.stringify(e);
  return receiveStripeWebhook(raw, sig ?? sign(raw), SECRET);
};
const account = (orgId: string) => db.billingAccount.findUnique({ where: { orgId } });

describe('INV-12 webhooks verify the raw body and timestamp window', () => {
  it('no secret configured: 503, nothing written', async () => {
    const raw = JSON.stringify(subEvent((await makeOrg()).id));
    expect((await receiveStripeWebhook(raw, sign(raw), undefined)).status).toBe(503);
    expect(await db.stripeEvent.count()).toBe(0);
  });

  it.each([
    ['missing signature', (raw: string) => [raw, null]],
    ['wrong secret', (raw: string) => [raw, sign(raw, undefined, 'whsec_other')]],
    ['tampered body', (raw: string) => [raw.replace('active', 'canceled'), sign(raw)]],
    ['stale timestamp', (raw: string) => [raw, sign(raw, Math.floor(now().getTime() / 1000) - 301)]],
    ['future timestamp', (raw: string) => [raw, sign(raw, Math.floor(now().getTime() / 1000) + 301)]],
    ['garbage header', (raw: string) => [raw, 't=abc,v1=00']],
  ] as const)('%s: 400, nothing written', async (_, bad) => {
    const org = await makeOrg();
    const [raw, sig] = bad(JSON.stringify(subEvent(org.id))) as [string, string | null];
    expect((await receiveStripeWebhook(raw, sig, SECRET)).status).toBe(400);
    expect(await db.stripeEvent.count()).toBe(0);
    expect(await account(org.id)).toBeNull();
  });

  it('a valid signature among several v1 values is accepted', async () => {
    const org = await makeOrg();
    const raw = JSON.stringify(subEvent(org.id));
    expect((await receiveStripeWebhook(raw, `${sign(raw)},v1=${'0'.repeat(64)}`, SECRET)).status).toBe(200);
  });
});

describe('INV-12 a failed delivery is re-applied; a true duplicate is a no-op', () => {
  it('first apply throws → 500; redelivery applies; a third changes nothing', async () => {
    const org = await makeOrg();
    const e = subEvent(org.id);
    vi.spyOn(handlers, 'customer.subscription.updated').mockRejectedValueOnce(new Error('db blip'));

    const first = await deliver(e);
    expect(first.status).toBe(500);
    expect(await db.stripeEvent.findUnique({ where: { id: e.id } })).toMatchObject({ processedAt: null, error: 'db blip' });
    expect(await account(org.id)).toBeNull();

    expect((await deliver(e)).status).toBe(200); // SB answered "duplicate" here and lost the event
    const applied = await account(org.id);
    expect(applied).toMatchObject({ status: 'active', plan: 'price_pro', stripeCustomerId: 'cus_1' });
    expect(await db.stripeEvent.findUnique({ where: { id: e.id } })).toMatchObject({ error: null, processedAt: expect.any(Date) });

    const third = await deliver(e);
    expect(third).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(await account(org.id)).toEqual(applied);
  });

  it('concurrent deliveries of one event apply it once, fresh or after a failure', async () => {
    const org = await makeOrg();
    const spy = vi.spyOn(handlers, 'customer.subscription.updated');
    const fresh = subEvent(org.id);
    expect((await Promise.all([deliver(fresh), deliver(fresh), deliver(fresh)])).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(spy).toHaveBeenCalledTimes(1);

    // The row already exists unprocessed, so only the event row's lock serialises the retries.
    const retried = subEvent(org.id, { created: 1_800_000_001 });
    spy.mockClear().mockRejectedValueOnce(new Error('db blip'));
    expect((await deliver(retried)).status).toBe(500);
    spy.mockImplementation(async (...a) => {
      await new Promise((r) => setTimeout(r, 50)); // hold the transaction open so the retries overlap
      return handlers['customer.subscription.created']!(...a);
    });
    expect((await Promise.all([deliver(retried), deliver(retried), deliver(retried)])).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(spy).toHaveBeenCalledTimes(2); // the failed apply, then exactly one re-apply
  });

  it('an older event delivered late does not overwrite a newer state', async () => {
    const org = await makeOrg();
    await deliver(subEvent(org.id, { status: 'canceled', created: 1_800_000_100, type: 'customer.subscription.deleted' }));
    await deliver(subEvent(org.id, { status: 'active', created: 1_800_000_000 }));
    expect(await account(org.id)).toMatchObject({ status: 'canceled' });
    await deliver(subEvent(org.id, { status: 'active', price: 'price_max', created: 1_800_000_200, type: 'customer.subscription.created' }));
    expect(await account(org.id)).toMatchObject({ status: 'active', plan: 'price_max' });
  });

  it('an unhandled type or an unknown org is acknowledged, not retried', async () => {
    const org = await makeOrg();
    expect((await deliver({ ...subEvent(org.id), type: 'invoice.paid' })).status).toBe(200);
    expect((await deliver(subEvent('00000000-0000-4000-8000-000000000999'))).status).toBe(200);
    expect((await deliver(subEvent('not-a-uuid'))).status).toBe(200);
    expect(await db.billingAccount.count()).toBe(0);
    expect(await db.stripeEvent.count({ where: { processedAt: null } })).toBe(0);
  });
});

describe('FR-04 the org follows one subscription; FR-05 deleting the org cancels it', () => {
  it('a second subscription cannot overwrite the bound one; after that one ends, a re-subscribe takes over', async () => {
    const org = await makeOrg();
    await deliver(subEvent(org.id, { sub: 'sub_A', created: 1_800_000_000 }));
    await deliver(subEvent(org.id, { sub: 'sub_B', status: 'canceled', created: 1_800_000_100 }));
    expect(await account(org.id)).toMatchObject({ stripeSubscriptionId: 'sub_A', status: 'active' });
    await deliver(subEvent(org.id, { sub: 'sub_A', status: 'canceled', created: 1_800_000_200 }));
    await deliver(subEvent(org.id, { sub: 'sub_C', price: 'price_max', created: 1_800_000_300 }));
    expect(await account(org.id)).toMatchObject({ stripeSubscriptionId: 'sub_C', status: 'active', plan: 'price_max' });
    await deliver(subEvent(org.id, { sub: 'sub_A', status: 'canceled', created: 1_800_000_400 })); // the old one, late
    expect(await account(org.id)).toMatchObject({ stripeSubscriptionId: 'sub_C', status: 'active' });
  });

  it('checkout is refused while the org has a live subscription', async () => {
    const org = await makeOrg();
    await actAs((await addMember(org.id, 'owner', 'owner@example.test')).id, org.slug);
    const attempt = { attempt: 'attempt-0123456789abcdef' };
    await deliver(subEvent(org.id, { status: 'past_due' }));
    expect(await startCheckout(org.slug, attempt)).toMatchObject({ error: expect.stringContaining('already has a subscription') });
    await deliver(subEvent(org.id, { status: 'canceled', created: 1_800_000_100 }));
    await expect(startCheckout(org.slug, attempt)).rejects.toThrow('checkout=mock'); // on to checkout
  });

  it('deleting the org cancels a live subscription first; if that fails the org stays', async () => {
    const cancel = vi.spyOn(mockProvider, 'cancel');
    const org = await makeOrg();
    await actAs((await addMember(org.id, 'owner', 'owner@example.test')).id, org.slug);
    await deliver(subEvent(org.id, { sub: 'sub_A' }));
    cancel.mockRejectedValueOnce(new Error('stripe down'));
    await expect(destroyOrg(org.slug, { confirm: org.slug })).rejects.toThrow('stripe down');
    expect(await db.org.count()).toBe(1);
    await expect(destroyOrg(org.slug, { confirm: org.slug })).rejects.toThrow('/onboarding');
    expect(cancel).toHaveBeenLastCalledWith('sub_A');
    expect(await db.org.count()).toBe(0);

    const ended = await makeOrg('ended');
    await actAs((await addMember(ended.id, 'owner', 'o2@example.test')).id, ended.slug);
    await deliver(subEvent(ended.id, { sub: 'sub_E', status: 'canceled' }));
    await expect(destroyOrg(ended.slug, { confirm: ended.slug })).rejects.toThrow('/onboarding');
    expect(cancel).toHaveBeenCalledTimes(2); // not for the ended one
  });

  it('stripe cancel is a DELETE, and a subscription Stripe no longer has counts as cancelled', async () => {
    const calls: [string, string][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push([String(init?.method), String(url)]);
      return Response.json({ error: { message: 'No such subscription' } }, { status: calls.length === 1 ? 404 : 500 });
    });
    const p = stripeProvider('sk_test_x', 'price_pro');
    await p.cancel('sub_gone');
    await expect(p.cancel('sub_x')).rejects.toThrow('500');
    expect(calls[0]).toEqual(['DELETE', 'https://api.stripe.com/v1/subscriptions/sub_gone']);
  });
});

describe('Idempotency-Key on Stripe creates', () => {
  it('checkout sends the caller-derived key; the portal sends none', async () => {
    const sent: Headers[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push(new Headers(init?.headers));
      return Response.json({ url: 'https://checkout.stripe.test/s' });
    });
    const p = stripeProvider('sk_test_x', 'price_pro');
    const input = { orgId: 'o1', customerId: null, email: 'a@example.test', returnUrl: 'http://app.test/b', idempotencyKey: 'checkout:o1:attempt-1' };
    await p.checkout(input);
    await p.checkout(input); // a retry of the same attempt
    await p.portal({ customerId: 'cus_1', returnUrl: 'http://app.test/b' });
    expect(sent.map((h) => h.get('idempotency-key'))).toEqual(['checkout:o1:attempt-1', 'checkout:o1:attempt-1', null]);
  });
});

// Owner decision 2026-10-13, with the rest of the demo rules in tests/integration/review-2026-10-12-demo.test.ts:
// a /demo visitor must not open a checkout or the Stripe portal for the shared demo org.
describe('a demo session cannot use billing', () => {
  it('checkout and the portal are refused before the provider is called', async () => {
    await seedDemo();
    // Seed-agnostic (a clone's seed has its own orgs): the first demo org's owner.
    const m = await db.membership.findFirstOrThrow({ where: { role: 'owner', user: { isDemo: true } }, orderBy: { org: { slug: 'asc' } }, select: { user: true, org: true } });
    const { user: owner, org } = m;
    await deliver(subEvent(org.id, { status: 'canceled' })); // a customer id on file, so the portal has somewhere to go
    jar.set(SESSION_COOKIE, (await demoSignIn(owner.id))!);
    const checkout = vi.spyOn(mockProvider, 'checkout');
    const portal = vi.spyOn(mockProvider, 'portal');
    const DEMO = { error: expect.stringMatching(/shared demo account/) };
    expect(await startCheckout(org.slug, { attempt: 'attempt-0123456789abcdef' })).toEqual(DEMO);
    expect(await openPortal(org.slug, {})).toEqual(DEMO);
    expect(checkout).not.toHaveBeenCalled();
    expect(portal).not.toHaveBeenCalled();
  });
});
