import { requireOrg } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { newToken } from '@/core/tokens';
import { ActionForm } from '@/core/ui/action-form';
import { isLive } from '@/modules/billing/provider';
import { openPortal, startCheckout } from './actions';

export const metadata = { title: 'Billing' };

export default async function Billing({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ checkout?: string }> }) {
  const ctx = await requireOrg((await params).org, 'billing.manage');
  const [acct, { checkout }] = await Promise.all([withOrg(ctx, (tx) => tx.billingAccount.findUnique({ where: { orgId: ctx.orgId } }), { atomic: false }), searchParams]);
  const live = isLive(acct?.status);

  return (
    <main>
      <h1>Billing</h1>
      {checkout === 'done' && !live && <p role="status">Payment received. Your plan updates as soon as Stripe confirms it.</p>}
      {checkout === 'mock' && <p role="status">Mock provider: no payment was taken and the plan is unchanged.</p>}
      {acct?.status ? (
        <p>
          Plan <strong>{acct.plan ?? 'unknown'}</strong>, status <strong>{acct.status}</strong>
          {acct.currentPeriodEnd && <>, current period ends {acct.currentPeriodEnd.toISOString().slice(0, 10)}</>}.
        </p>
      ) : (
        <p>No subscription.</p>
      )}
      {!live && (
        <ActionForm action={startCheckout.bind(null, ctx.slug)}>
          <input type="hidden" name="attempt" value={newToken()} />
          <button type="submit">Subscribe</button>
        </ActionForm>
      )}
      {acct?.stripeCustomerId && (
        <ActionForm action={openPortal.bind(null, ctx.slug)}>
          <button type="submit">Manage billing</button>
        </ActionForm>
      )}
    </main>
  );
}
