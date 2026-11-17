// PROVEN-DEFECT TESTS — audit 2026-11-17 (docs/audits/AUDIT-2026-11-17.md). NON-GATING ON PURPOSE.
//
// Every test here states the CORRECT behaviour and FAILS against the code as it stands on v1.6.3: each failure is the
// evidence for one finding (the id in the test name). vitest.config.ts includes only tests/**/*.test.ts, so this file
// is not part of `npm test` or CI's required checks. Run it with:
//
//   npx dotenv -e .env.test -e .env.local -- vitest run --config vitest.defects.config.ts
//
// When a finding is fixed its test goes green; move it into tests/invariants/ then, and delete it from here.
// Nothing in this file changes production code, and no existing test was skipped, deleted or weakened for it.
import { randomUUID } from 'node:crypto';
import '@/app/modules'; // registers the sso hooks, as the sign-in routes do
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onMembershipEnded } from '@/app/org-hooks';
import { BudgetExceeded, HOLD_MS, withBudget } from '@/core/ai/budget';
import { redeemLink, requestLink } from '@/core/auth/link';
import { SESSION_COOKIE } from '@/core/auth/session';
import { requireOrg } from '@/core/authz/guards';
import { advanceClock, now } from '@/core/clock';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env } from '@/core/env';
import { emit } from '@/core/events';
import { Refused } from '@/core/errors';
import { changeRole, removeMember } from '@/core/tenancy/orgs';
import { createKey, resolveKey } from '@/modules/apikeys/keys';
import { checkUrl, createEndpoint, isPrivateAddress, sweepWebhooks, transport } from '@/modules/apikeys/webhooks';
import { saveConnection, setRequired } from '@/modules/sso/settings';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { jar } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';

const realTransport = { ...transport };
beforeEach(async () => {
  await resetAuthTables();
  transport.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
});
afterEach(() => {
  Object.assign(transport, realTransport);
  advanceClock(0);
});

async function orgWithOwner(slug: string) {
  const o = await makeOrg(slug);
  const owner = await addMember(o.id, 'owner', `owner@${slug}.test`);
  return { orgId: o.id, slug, ownerId: owner.id, owner: await actAs(owner.id, slug) };
}

// ---------------------------------------------------------------------------------------------------------------
// A-01 (high): the webhook SSRF filter does not recognise IPv6 spellings of private IPv4 addresses.
// `new URL()` rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and isPrivateAddress only matches the dotted form.
// ---------------------------------------------------------------------------------------------------------------
describe('A-01 webhook endpoints: IPv6 forms of private IPv4 addresses must be refused', () => {
  it.each([
    ['loopback, IPv4-mapped', 'https://[::ffff:127.0.0.1]/in'],
    ['cloud metadata, IPv4-mapped', 'https://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['RFC 1918, IPv4-mapped', 'https://[::ffff:10.0.0.5]/in'],
    ['RFC 1918, IPv4-mapped, already hex', 'https://[::ffff:c0a8:1]/in'],
    ['cloud metadata through NAT64 (64:ff9b::/96)', 'https://[64:ff9b::a9fe:a9fe]/in'],
  ])('%s: %s', async (_, url) => {
    await expect(checkUrl(url, false)).rejects.toBeInstanceOf(Refused);
  });

  it('a DNS answer in the hex-mapped form is private too', async () => {
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    transport.lookup = async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }];
    await expect(checkUrl('https://hooks.example.test/in', false)).rejects.toBeInstanceOf(Refused);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A-02 (medium): the SSO issuer is fetched server-side (discovery, token, JWKS, userinfo) with no address check at
// all. The webhook module has checkUrl; the sso module has only "must be https".
// ---------------------------------------------------------------------------------------------------------------
describe('A-02 SSO issuer: a private or link-local address must be refused at save', () => {
  beforeAll(() => void (env.SSO_ENABLED = '1'));
  afterAll(() => void (env.SSO_ENABLED = undefined));

  it.each(['https://169.254.169.254/', 'https://10.0.0.5/realms/x', 'https://[::1]/', 'https://localhost/'])('%s', async (issuer) => {
    const a = await orgWithOwner('acme');
    const save = saveConnection(a.owner, { issuer, clientId: 'c', clientSecret: 's', allowedDomains: '', defaultRole: 'member' });
    await expect(save).rejects.toBeInstanceOf(Refused);
    expect(await db.ssoConnection.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A-03 (medium): a model call that RAN but cannot be priced leaves no ledger row. costMicros() throws after fn()
// has already spent the money, so the spend is invisible and the cap is never reached.
// ---------------------------------------------------------------------------------------------------------------
describe('A-03 AI budget: a call that ran is always counted, priced or not', () => {
  const MAX = 10_000n; // 1¢
  const UNPRICED = { usage: { provider: 'anthropic', model: 'claude-sonnet-5-5-20261101', inputTokens: 0, outputTokens: 1000 } };

  async function capped() {
    const a = await orgWithOwner('acme');
    await db.aiBudget.create({ data: { orgId: a.orgId, monthlyCapMicros: MAX } });
    return { orgId: a.orgId, userId: a.ownerId };
  }

  it('every call whose fn ran has an AiUsage row (or the call is refused before fn runs)', async () => {
    const ctx = await capped();
    const fn = vi.fn(async () => UNPRICED);
    await withBudget(ctx, 'answer', MAX, fn).catch(() => {});
    expect(await db.aiUsage.count(), 'model calls made vs ledger rows').toBe(fn.mock.calls.length);
  });

  it('a 1¢ cap cannot be passed by repeating an unpriced model', async () => {
    const ctx = await capped();
    const fn = vi.fn(async () => UNPRICED);
    for (let i = 0; i < 5; i++) {
      await withBudget(ctx, 'answer', MAX, fn).catch(() => {});
      advanceClock((i + 1) * (HOLD_MS + 1000)); // the orphaned hold lapses, as it does 15 minutes later in production
    }
    expect(fn.mock.calls.length, 'calls that reached the provider under a cap that affords one').toBeLessThanOrEqual(1);
  });

  // A-09 (low): the estimate is trusted. A negative one lowers `committed` and lets other calls through the hard cap.
  it('A-09 a negative estimate is refused, and fn never runs', async () => {
    const ctx = await capped();
    const fn = vi.fn(async () => ({ usage: { provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 1 } }));
    await expect(withBudget(ctx, 'answer', -1_000_000n, fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
    // and it must not have widened the cap for the next caller: a 2¢ estimate against a 1¢ cap is refused
    await expect(withBudget(ctx, 'answer', 20_000n, fn)).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A-04 (medium): what a person set up outlives their access. INV-40 revokes the API keys a removed member created;
// the webhook endpoint they pointed at their own server keeps receiving every event, signed with a secret they hold.
// ---------------------------------------------------------------------------------------------------------------
describe('A-04 a webhook endpoint does not outlive the membership of the person who created it', () => {
  it('after the admin is removed, the org publishes an event: nothing is sent to their endpoint', async () => {
    const a = await orgWithOwner('acme');
    const admin = await addMember(a.orgId, 'admin', 'leaver@acme.test');
    await createEndpoint(await actAs(admin.id, 'acme'), { url: 'https://leaver-controlled.example.test/collect', eventTypes: [] });
    await removeMember(await actAs(a.ownerId, 'acme'), admin.id, onMembershipEnded);

    const sent: string[] = [];
    transport.fetch = vi.fn(async (url: string) => (sent.push(url), new Response('ok')));
    await withOrg(a, (tx) => emit(a, 'project.created', { project: { name: 'After they left' } }, tx));
    await sweepWebhooks();
    expect(sent).toEqual([]);
  });
});

// A-08 (low): the same rule for a demotion. An admin made a key, then lost apikeys.manage; the key still works.
describe('A-08 an API key does not outlive its creator’s right to manage keys', () => {
  it('admin → member: the key that admin created no longer resolves', async () => {
    const a = await orgWithOwner('acme');
    const admin = await addMember(a.orgId, 'admin', 'demoted@acme.test');
    const key = await createKey(await actAs(admin.id, 'acme'), { label: 'crm', scopes: ['read', 'write'] });
    await changeRole(await actAs(a.ownerId, 'acme'), admin.id, 'member');
    expect(await resolveKey(`Bearer ${key}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A-05 / A-06 / A-07: "Require SSO" (INV-36) is enforced only where a magic link is requested or redeemed.
// ---------------------------------------------------------------------------------------------------------------
describe('Require SSO', () => {
  const DOMAIN = 'corp.example';
  beforeAll(() => void (env.SSO_ENABLED = '1'));
  afterAll(() => void (env.SSO_ENABLED = undefined));

  async function ssoOrg(slug = 'corp') {
    const a = await orgWithOwner(slug);
    await db.ssoConnection.create({ data: { orgId: a.orgId, issuer: 'https://idp.corp.example', clientId: 'c', clientSecretSealed: 'x', allowedDomains: [DOMAIN], enabledAt: now() } });
    await db.ssoDomain.create({ data: { orgId: a.orgId, domain: DOMAIN, verifiedAt: now() } });
    return a;
  }
  const links = (email: string) => db.loginToken.count({ where: { email } });
  const outcome = (slug: string) => requireOrg(slug).then(() => 'admitted', () => 'refused');

  // A-05 (medium): a session made by magic link before the switch keeps working in the org for up to 30 days.
  it('A-05 turning Require SSO on ends a member’s existing magic-link session in that org', async () => {
    const a = await ssoOrg();
    const member = await addMember(a.orgId, 'member', `mel@${DOMAIN}`);
    const memberToken = await signInAs(member.id, { mfa: true }); // signed in by link yesterday; the session lives 30 days
    expect(await outcome(a.slug)).toBe('admitted');

    await setRequired(await actAs(a.ownerId, a.slug), true);

    jar.clear();
    jar.set(SESSION_COOKIE, memberToken);
    expect(await outcome(a.slug), 'a link session in an SSO-required org').toBe('refused');
  });

  // A-06 (medium): the rule is per USER, not per org, and takes no account of whether the user can use SSO at all.
  it('A-06 a member whose address is not on the org’s domain can still sign in to their OWN org', async () => {
    const a = await ssoOrg();
    const contractor = await addMember(a.orgId, 'member', 'pat@freelance.example'); // invited; cannot use corp's IdP
    const own = await makeOrg('pats-studio');
    await db.membership.create({ data: { orgId: own.id, userId: contractor.id, role: 'owner' } });

    await setRequired(await actAs(a.ownerId, a.slug), true);
    await requestLink(contractor.email, randomUUID());
    expect(await links(contractor.email), 'sign-in links for the owner of pats-studio').toBe(1);
  });

  it('A-06 an org whose only owner is off-domain is not locked out for good once the 24 h exemption lapses', async () => {
    const a = await ssoOrg(); // owner@corp.test: not on corp.example, so the IdP can never sign them in (INV-35)
    const on = await setRequired(a.owner, true).then(() => true, (e) => (e instanceof Refused ? false : Promise.reject(e)));
    if (!on) return; // fixed by refusing the switch: also fine
    advanceClock(24 * 3600_000 + 60_000);
    await requestLink(a.owner.session.email, randomUUID());
    expect(await links(a.owner.session.email), 'ways left for the only owner to sign in and turn it off').toBeGreaterThan(0);
  });

  // A-07 (low): redeemLink checks ssoRefusesLink only when the token row already names a user. A sign-up link does not.
  it('A-07 a sign-up link issued before the account existed does not sign in a member of an SSO-required org', async () => {
    const a = await ssoOrg();
    await db.ssoConnection.update({ where: { orgId: a.orgId }, data: { required: true, requiredAt: now(), requiredById: null } });
    const email = 'newhire@elsewhere.example';
    await requestLink(email, randomUUID()); // unknown address → a 15-minute sign-up token with userId = null
    const row = await db.loginToken.findFirstOrThrow({ where: { email } });
    expect(row.purpose).toBe('signup');
    // within those 15 minutes the account appears and joins the org (SSO JIT, or an admin adds them)
    await addMember(a.orgId, 'member', email);
    // the emailed token is unknown to the test (only its hash is stored), so plant one of the same shape
    const token = randomUUID();
    const { hashToken } = await import('@/core/tokens');
    await db.loginToken.create({ data: { ...row, hash: hashToken(token) } });
    expect(await redeemLink(token)).toBeNull();
  });
});
