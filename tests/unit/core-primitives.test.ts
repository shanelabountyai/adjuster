import { describe, expect, it } from 'vitest';
import { can, mayAssign } from '@/core/authz/permissions';
import { clientIp, isSameOrigin } from '@/core/http';
import { hashToken, newToken, safeEqual } from '@/core/tokens';
import { openSecret, sealSecret } from '@/core/auth/secret-box';

describe('permissions', () => {
  it('only an owner can delete the org or manage billing', () => {
    expect(can('owner', 'org.delete')).toBe(true);
    expect(can('owner', 'billing.manage')).toBe(true);
    for (const r of ['admin', 'member', 'scorekeeper'] as const) {
      expect(can(r, 'org.delete')).toBe(false);
      expect(can(r, 'billing.manage')).toBe(false);
    }
  });
  it('a scorekeeper holds results.write and nothing else (D-21)', () => {
    expect(can('scorekeeper', 'results.write')).toBe(true);
    for (const p of ['org.update', 'members.manage', 'share.create', 'share.revoke', 'audit.read'] as const) {
      expect(can('scorekeeper', p)).toBe(false);
    }
  });
  it('an unknown role gets nothing', () => {
    expect(can('nobody' as never, 'share.create')).toBe(false);
  });
  it('mayAssign: only an owner touches the owner role (INV-28)', () => {
    expect(mayAssign('owner', null, 'owner')).toBe(true);
    expect(mayAssign('owner', 'owner', null)).toBe(true);
    expect(mayAssign('admin', null, 'owner')).toBe(false);
    expect(mayAssign('admin', 'owner', 'member')).toBe(false);
    expect(mayAssign('admin', 'owner', null)).toBe(false);
    expect(mayAssign('admin', 'member', 'admin')).toBe(true);
    expect(mayAssign('admin', null, 'member')).toBe(true);
  });
  it('mayAssign: a role without members.manage assigns nothing', () => {
    expect(mayAssign('member', null, 'member')).toBe(false);
    expect(mayAssign('scorekeeper', 'member', 'admin')).toBe(false);
  });
});

describe('clientIp', () => {
  const h = (xff?: string) => new Headers(xff ? { 'x-forwarded-for': xff } : {});
  it('is "unknown" with no header, and takes the first hop of a list', () => {
    expect(clientIp(h())).toBe('unknown');
    expect(clientIp(h('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
  });
  it('buckets IPv6 by /64 so rotating the low 64 bits does not dodge a limit (K5)', () => {
    const a = clientIp(h('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    const b = clientIp(h('2001:db8:1:2:1111:2222:3333:4444'));
    expect(a).toBe('2001:db8:1:2');
    expect(b).toBe(a);
    expect(clientIp(h('2001:db8:1:3::1'))).not.toBe(a);
  });
  it('expands "::" and strips a zone id', () => {
    expect(clientIp(h('2001:db8::1'))).toBe('2001:db8:0:0');
    expect(clientIp(h('::1'))).toBe('0:0:0:0');
    expect(clientIp(h('fe80::1%eth0'))).toBe('fe80:0:0:0');
  });
});

describe('isSameOrigin', () => {
  it('compares Origin host to Host', () => {
    expect(isSameOrigin(new Headers({ origin: 'http://localhost:4100', host: 'localhost:4100' }))).toBe(true);
    expect(isSameOrigin(new Headers({ origin: 'https://evil.test', host: 'localhost:4100' }))).toBe(false);
  });
  it('refuses an unparseable Origin, including the opaque "null"', () => {
    expect(isSameOrigin(new Headers({ origin: 'null', host: 'localhost:4100' }))).toBe(false);
  });
  it('without Origin, falls back to Sec-Fetch-Site and otherwise refuses', () => {
    expect(isSameOrigin(new Headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(new Headers({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(new Headers())).toBe(false);
  });
});

describe('tokens', () => {
  it('newToken is unique and url-safe; hashToken is a stable sha256 hex that is not the token', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toContain(a);
  });
  it('safeEqual: equal, different, and different-length strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('secret-box (INV-25)', () => {
  it('round-trips, with a fresh IV each time', () => {
    const a = sealSecret('JBSWY3DPEHPK3PXP', 'totp');
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(a, 'totp')).toBe('JBSWY3DPEHPK3PXP');
    expect(sealSecret('JBSWY3DPEHPK3PXP', 'totp')).not.toBe(a);
  });
  it('a different purpose cannot open it', () => {
    expect(openSecret(sealSecret('x', 'totp'), 'other')).toBeNull();
  });
  it('tampering with any part, or a malformed value, returns null instead of throwing', () => {
    const [iv, ct, tag] = sealSecret('hello', 'totp').split('.') as [string, string, string];
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(openSecret([iv, flip(ct), tag].join('.'), 'totp')).toBeNull();
    expect(openSecret([iv, ct, flip(tag)].join('.'), 'totp')).toBeNull();
    expect(openSecret([flip(iv), ct, tag].join('.'), 'totp')).toBeNull();
    expect(openSecret('', 'totp')).toBeNull();
    expect(openSecret('a.b', 'totp')).toBeNull();
    expect(openSecret('not-sealed', 'totp')).toBeNull();
  });
});
