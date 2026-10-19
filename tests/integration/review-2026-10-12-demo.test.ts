// 2026-10-12 review, demo finding: what a /demo session may do, and what happens to demo accounts once
// DEMO_MODE is off. INV-27 (tests/invariants/inv-27-demo.test.ts) covers who may sign in at /demo.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts parses process.env at import; this file runs with the flag on, as a demo deployment does.
vi.hoisted(() => { process.env.DEMO_MODE = '1'; });

import { db } from '@/core/db';
import { demoSignIn } from '@/core/auth/demo';
import { redeemLink, requestEmailChange, requestLink } from '@/core/auth/link';
import { currentSession, SESSION_COOKIE, sessionFor } from '@/core/auth/session';
import { disableTotp, enrolTotp } from '@/core/auth/totp';
import { requireOrg } from '@/core/authz/guards';
import { deleteAccount, deleteOrg } from '@/core/tenancy/delete';
import { createInvite } from '@/core/tenancy/invites';
import { changeRole, createOrg, removeMember } from '@/core/tenancy/orgs';
import { seedDemo } from '../../scripts/seed-demo';
import { makeUser, resetAuthTables, signInAs } from '../helpers/auth';
import { jar } from '../helpers/next';

beforeEach(resetAuthTables);

const DEMO = /shared demo account/;
const demoUser = (email: string) => db.user.findUniqueOrThrow({ where: { email } });

/** Signs the jar in the way /demo/signin does. */
async function viaDemo(email: string) {
  const u = await demoUser(email);
  jar.set(SESSION_COOKIE, (await demoSignIn(u.id))!);
  return u;
}

describe('a demo session cannot destroy the demo or change who owns it', () => {
  it('org and account deletion, email change and TOTP changes are refused, on a fresh session', async () => {
    await seedDemo();
    await viaDemo('owner@acme.demo.test');
    const ctx = await requireOrg('acme');
    await expect(deleteOrg(ctx, 'acme')).rejects.toThrow(DEMO);
    await expect(requestEmailChange(ctx.session, 'mine@example.test')).rejects.toThrow(DEMO);
    await expect(disableTotp()).rejects.toThrow(DEMO);

    const admin = await viaDemo('admin@acme.demo.test');
    await expect(deleteAccount((await currentSession())!, admin.email)).rejects.toThrow(DEMO);
    await viaDemo('member@acme.demo.test');
    await expect(enrolTotp()).rejects.toThrow(DEMO);

    // Every /demo visitor shares the account, so "sign out everywhere" would sign the others out.
    const { signOutAll } = await import('@/app/account/security/actions');
    const sessions = await db.session.count();
    expect(await signOutAll({})).toEqual({ error: expect.stringMatching(DEMO) });
    expect(await db.session.count()).toBe(sessions);

    expect(await db.org.count({ where: { slug: 'acme' } })).toBe(1);
    expect(await db.user.count({ where: { isDemo: true, totpEnrolledAt: { not: null } } })).toBe(4);
    expect(await db.user.count({ where: { isDemo: true } })).toBe(6);
    expect(await db.loginToken.count()).toBe(0);
  });

  it('inviting, re-roling, removing and leaving are refused', async () => {
    await seedDemo();
    const member = await demoUser('member@acme.demo.test');
    await viaDemo('owner@acme.demo.test');
    const ctx = await requireOrg('acme');
    await expect(createInvite(ctx, 'mine@example.test', 'owner')).rejects.toThrow(DEMO);
    await expect(changeRole(ctx, member.id, 'owner')).rejects.toThrow(DEMO);
    await expect(removeMember(ctx, member.id)).rejects.toThrow(DEMO);
    await viaDemo('member@acme.demo.test');
    await expect(removeMember(await requireOrg('acme'), member.id)).rejects.toThrow(DEMO);

    expect(await db.invite.count()).toBe(0);
    expect(await db.membership.count({ where: { org: { slug: 'acme' } } })).toBe(3);
    expect(await db.membership.count({ where: { userId: member.id, role: 'member' } })).toBe(1);
  });

  // Owner decision 2026-10-13. Billing is a removable module, so its half is in tests/invariants/inv-12-webhooks.test.ts.
  it('creating an org is refused; adding a project and sharing it still work', async () => {
    await seedDemo();
    await viaDemo('owner@acme.demo.test');
    const orgs = await db.org.count();
    await expect(createOrg((await currentSession())!, 'Mine')).rejects.toThrow(DEMO);
    const { startOrg } = await import('@/app/onboarding/actions');
    expect(await startOrg({ name: 'Mine' })).toEqual({ error: expect.stringMatching(DEMO) });
    expect(await db.org.count()).toBe(orgs);

    const { addProject, shareProject } = await import('@/app/o/[org]/projects/actions');
    await expect(addProject('acme', { name: 'Demo project' })).rejects.toThrow('redirect /o/acme/projects');
    const p = await db.project.findFirstOrThrow({ where: { name: 'Demo project' } });
    expect(await shareProject('acme', { id: p.id, days: '7' })).toEqual({ notice: expect.stringContaining('/s/') });
  });

  it('a real account is not affected', async () => {
    const u = await makeUser('real@example.test');
    await signInAs(u.id);
    await requestEmailChange((await currentSession())!, 'real2@example.test');
    expect(await db.loginToken.count({ where: { purpose: 'email_change' } })).toBe(1);
    expect(await createOrg((await currentSession())!, 'Real')).toBe('real');
  });
});

describe('demo accounts stop working when DEMO_MODE is off', () => {
  it('no session resolves for a demo user, however it was made; a real user is unaffected', async () => {
    await seedDemo();
    const owner = await demoUser('owner@acme.demo.test');
    const token = (await demoSignIn(owner.id))!;
    expect(await sessionFor(token, { DEMO_MODE: '1' })).not.toBeNull();
    expect(await sessionFor(token, {})).toBeNull();

    // The magic-link route in: the demo address plus the public TOTP seed is a full login otherwise.
    await requestLink(owner.email, '10.0.0.1');
    const link = (await db.capturedMessage.findFirstOrThrow({ where: { to: owner.email } })).body.match(/\/login\/([\w-]+)/)![1]!;
    expect(await sessionFor((await redeemLink(link))!, {})).toBeNull();

    const real = await makeUser('real@example.test');
    expect(await sessionFor(await signInAs(real.id), {})).not.toBeNull();
  });
});
