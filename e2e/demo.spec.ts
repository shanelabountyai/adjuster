import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

// INV-27, flag-on half (the flag-off half is tests/invariants/inv-27-demo.test.ts). playwright.config.ts starts the
// server with DEMO_MODE=1; this spec seeds the same database itself.
// Seeded as a child process: a clone's seed may import `next/navigation`, which Playwright's loader cannot resolve (F-08).
test.beforeAll(() => { execSync('npm run seed:demo:test'); });

test('demo sign-in lands a seeded owner in their org', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'owner@acme.demo.test' }).click();
  await expect(page.getByRole('heading', { name: 'Your orgs' })).toBeVisible();
  await page.getByRole('link', { name: 'Acme Studio' }).click();
  await expect(page.getByRole('navigation')).toContainText('Acme Studio');
});
