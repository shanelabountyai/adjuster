// public: 404s unless DEMO_MODE (INV-27)
import { notFound } from 'next/navigation';
import { demoEnabled, listDemoUsers } from '@/core/auth/demo';
import { keepListedOrgs } from '@/core/tenancy/listed';
import { filterListedOrgs } from '@/app/org-hooks';

export const metadata = { title: 'Demo sign-in' };
export const dynamic = 'force-dynamic';

export default async function Demo() {
  if (!demoEnabled()) notFound();
  // Each account's orgs go through the clone's `filterListedOrgs`, as on /onboarding.
  const users = await Promise.all((await listDemoUsers()).map(async (u) => ({ ...u, memberships: await keepListedOrgs(u.id, u.memberships, filterListedOrgs) })));
  return (
    <main>
      <h1>Demo sign-in</h1>
      <p>Seeded demo accounts. Pick one to sign in, no email needed.</p>
      {users.length === 0 && <p role="status">No demo users yet. Run <code>npm run seed:demo</code>.</p>}
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <form method="post" action="/demo/signin">
              <input type="hidden" name="userId" value={u.id} />
              <button type="submit">{u.email}</button> {u.memberships.map((m) => `${m.role} of ${m.org.name}`).join(', ')}
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
