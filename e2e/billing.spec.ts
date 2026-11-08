import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';

// The billing page against the production build, with the mock provider (no STRIPE_SECRET_KEY in .env.test).
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_SYSTEM ?? process.env.DATABASE_URL, max: 1 }); // fixtures as the owner (RLS enforce)
test.afterAll(() => db.end());

async function seedOwner() {
  const [org, user, token] = [randomUUID(), randomUUID(), randomBytes(32).toString('base64url')];
  const slug = `e2e-bill-${org.slice(0, 8)}`;
  await db.query('INSERT INTO "Org" (id, slug, name, "updatedAt") VALUES ($1, $2, $2, now())', [org, slug]);
  await db.query('INSERT INTO "User" (id, email, "totpEnrolledAt", "updatedAt") VALUES ($1, $2, now(), now())', [user, `${slug}@example.test`]);
  await db.query(`INSERT INTO "Membership" ("orgId", "userId", role, "updatedAt") VALUES ($1, $2, 'owner', now())`, [org, user]);
  await db.query(
    `INSERT INTO "Session" (hash, "userId", "authAt", "mfaAt", "createdAt", "expiresAt") VALUES ($1, $2, now(), now(), now(), now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), user],
  );
  return { org, slug, token };
}

test('an owner subscribes through the mock provider, then sees the plan a webhook set', async ({ page, context, baseURL }) => {
  const { org, slug, token } = await seedOwner();
  await context.addCookies([{ name: '__Host-session', value: token, domain: 'localhost', path: '/', secure: true }]);

  await page.goto(`/o/${slug}/settings/billing`);
  await expect(page.getByText('No subscription.')).toBeVisible();
  await page.getByRole('button', { name: 'Subscribe' }).click();
  await expect(page).toHaveURL(/checkout=mock/);
  await expect(page.getByRole('status')).toContainText('Mock provider');

  await db.query(
    `INSERT INTO "BillingAccount" ("orgId", "stripeCustomerId", plan, status, "updatedAt") VALUES ($1, $2, 'pro', 'active', now())`,
    [org, `cus_${org.slice(0, 8)}`],
  );
  await page.goto(`/o/${slug}/settings/billing`);
  await expect(page.getByText(/Plan pro, status active/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Subscribe' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage billing' }).click();
  await expect(page).toHaveURL(/portal=mock/);
});
