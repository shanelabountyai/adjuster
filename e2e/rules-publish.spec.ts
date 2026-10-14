import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Browser } from '@playwright/test';
import pg from 'pg';
import { createDraft } from '@/adjudication/drafts';
import { staffAt } from '../tests/helpers/tiers';
import { seedDecisions } from '../scripts/seed-decisions';

// Task 4.11, against the production build. One user changes the deductible and sees GC-01 move; the author cannot
// publish; a second user does, and the version list names both. Rule sets are global, so the org is only the session.
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
test.afterAll(() => db.end());

async function member(slug: string, orgId: string, userId: string, name: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO "User" (id, email, name, "totpEnrolledAt", "updatedAt") VALUES ($1, $2, $3, now(), now())', [userId, `${name}-${userId.slice(0, 8)}@example.test`, name]);
  await db.query(`INSERT INTO "Membership" ("orgId", "userId", role, "updatedAt") VALUES ($1, $2, 'member', now())`, [orgId, userId]);
  await db.query(
    `INSERT INTO "Session" (hash, "userId", "authAt", "mfaAt", "createdAt", "expiresAt") VALUES ($1, $2, now(), now(), now(), now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), userId]);
  return token;
}

async function as(browser: Browser, token: string) {
  const context = await browser.newContext();
  await context.addCookies([{ name: '__Host-session', value: token, domain: 'localhost', path: '/', secure: true }]);
  return context.newPage();
}

test('one user edits the deductible, the author cannot publish, a second user does', async ({ browser }) => {
  test.setTimeout(240_000); // the seed decides ~20 claims through the pipeline
  await seedDecisions(db); // truncates the rule tables and TierAssignment, so the users are made after it
  const orgId = randomUUID();
  const slug = `e2e-rules-${orgId.slice(0, 8)}`;
  await db.query('INSERT INTO "Org" (id, slug, name, "updatedAt") VALUES ($1, $2, $2, now())', [orgId, slug]);
  const staff = await staffAt(db, ['senior', 'manager']);
  const author = await as(browser, await member(slug, orgId, staff.senior, 'Sena Author'));
  const publisher = await as(browser, await member(slug, orgId, staff.manager, 'Manny Publisher'));
  const draft = await createDraft(db, { kind: 'plan', product: 'electronics', userId: staff.senior, asOf: new Date().toISOString().slice(0, 10) });

  await author.goto(`/o/${slug}/rules/${draft}`);
  await author.locator('input[name="lookups.0.rows.0.value"]').fill('20000');
  await author.getByRole('button', { name: 'Save draft' }).first().click();
  await expect(author.getByRole('row', { name: /GC-01/ })).toBeVisible();
  await expect(author.getByText('someone else has to publish')).toBeVisible();
  await expect(author.getByRole('button', { name: 'Publish this draft' })).toBeDisabled();

  await publisher.goto(`/o/${slug}/rules/${draft}`);
  await expect(publisher.getByRole('row', { name: /GC-01/ })).toBeVisible();
  await publisher.getByRole('button', { name: 'Publish this draft' }).click();
  await expect(publisher.getByRole('term').filter({ hasText: 'Status' })).toBeVisible();
  await expect(publisher.getByText('published', { exact: true })).toBeVisible();

  await publisher.goto(`/o/${slug}/rules`);
  const row = publisher.getByRole('row').filter({ hasText: 'Sena Author' });
  await expect(row).toContainText('Manny Publisher');
});
