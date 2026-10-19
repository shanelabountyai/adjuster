'use server';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assertNotDemo } from '@/core/auth/session';
import { orgAction } from '@/core/authz/action';
import type { OrgCtx } from '@/core/authz/guards';
import { db } from '@/core/db';
import { env } from '@/core/env';
import { Refused } from '@/core/errors';
import { isLive, paymentProvider } from '@/modules/billing/provider';

const returnUrl = (ctx: OrgCtx) => `${env.APP_URL}/o/${ctx.slug}/settings/billing`;
const accountOf = (ctx: OrgCtx) => db.billingAccount.findUnique({ where: { orgId: ctx.orgId } });
const customerOf = async (ctx: OrgCtx) => (await accountOf(ctx))?.stripeCustomerId ?? null;

// `attempt` is minted once per rendered form, so a double submit or a retried request reuses the
// Idempotency-Key and Stripe returns the same checkout; a fresh visit gets a fresh one.
// ponytail: two checkouts opened side by side before either webhook lands still make two
// subscriptions; the webhook keeps the first and logs `billing.second_subscription` (FR-04).
// Store a pending checkout id if that ever happens for real.
export const startCheckout = orgAction('billing.manage', z.object({ attempt: z.string().regex(/^[\w-]{16,64}$/) }), async (ctx, i) => {
  assertNotDemo(ctx.session); // a /demo visitor must not subscribe the shared org, or reach its Stripe customer below
  const acct = await accountOf(ctx);
  if (isLive(acct?.status)) throw new Refused('This org already has a subscription. Change it from Manage billing.');
  const url = await paymentProvider().checkout({
    orgId: ctx.orgId,
    customerId: acct?.stripeCustomerId ?? null,
    email: ctx.session.email,
    returnUrl: returnUrl(ctx),
    idempotencyKey: `checkout:${ctx.orgId}:${i.attempt}`,
  });
  redirect(url);
});

export const openPortal = orgAction('billing.manage', z.object({}), async (ctx) => {
  assertNotDemo(ctx.session);
  const customerId = await customerOf(ctx);
  if (!customerId) throw new Refused('There is no billing account to manage yet.');
  redirect(await paymentProvider().portal({ customerId, returnUrl: returnUrl(ctx) }));
});
