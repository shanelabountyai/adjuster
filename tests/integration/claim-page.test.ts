import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import ClaimPage from '@/app/o/[org]/claims/[id]/page';
import { seedDecisions } from '../../scripts/seed-decisions';
import { resetAuthTables } from '../helpers/auth';
import { actAs, addMember, makeOrg } from '../helpers/org';

// Task 4.12. The claim page prints what is stored: GC-15's whole life, and a claim whose appeal was decided.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

let userId: string;
beforeAll(async () => {
  await client.connect();
  await resetAuthTables();
  await seedDecisions(client);
  userId = (await addMember((await makeOrg()).id, 'member', 'ada@example.test')).id;
});
const page = async (id: string) => {
  await actAs(userId, 'acme');
  return renderToStaticMarkup(await ClaimPage({ params: Promise.resolve({ org: 'acme', id }) }));
};

describe('the claim page', () => {
  it('reads GC-15 top to bottom: decisions in order with letters, documents, a waiver, the audit trail', async () => {
    const html = await page('GC-15');
    expect(html).toContain('Claim GC-15');
    expect(html).toContain('<h4>Letter</h4>');
    expect(html).toContain('override of');
    expect(html).toContain('waived');
    expect(html).toContain('claim.paid');
    expect(html.indexOf('1. ')).toBeLessThan(html.indexOf('2. '));
  });
  it('shows an appeal and who decided it', async () => {
    const html = await page('AP-02');
    expect(html).toContain('appeal decided by');
  });
  it('404s an unknown claim', async () => {
    await expect(page('NOPE')).rejects.toThrow();
  });
});
