import { describe, expect, it } from 'vitest';
import { refusal } from '../../eval/local-only';

// Hardening 2026-10-20. eval:signoff has no sign-in and a signature there is the hand labeling (D91 e), so it answers
// only this machine's browser on its own origin.
const P = 4901;
const get = (h: Record<string, string>) => refusal('GET', h, P);
const post = (h: Record<string, string>) => refusal('POST', h, P);

describe('eval:signoff answers only its own origin on the loopback', () => {
  it('serves this machine by either loopback name at its port', () => {
    expect(get({ host: 'localhost:4901' })).toBeNull();
    expect(get({ host: '127.0.0.1:4901' })).toBeNull();
  });
  it('refuses any other Host: another port, a LAN address, a rebinding name, none at all', () => {
    for (const host of ['localhost:4900', '192.168.1.20:4901', 'evil.example:4901', 'localhost']) expect(get({ host }), host).toBe('host is not this machine');
    expect(get({})).toBe('host is not this machine');
  });
  it('accepts the page’s own form post', () => {
    expect(post({ host: 'localhost:4901', origin: 'http://localhost:4901', 'sec-fetch-site': 'same-origin' })).toBeNull();
    expect(post({ host: '127.0.0.1:4901', origin: 'http://127.0.0.1:4901' })).toBeNull();
    expect(post({ host: 'localhost:4901' })).toBeNull(); // a non-browser client sends neither header
  });
  it('refuses a post a page elsewhere submits, by Sec-Fetch-Site or by Origin', () => {
    expect(post({ host: 'localhost:4901', 'sec-fetch-site': 'cross-site' })).toBe('cross-site post');
    expect(post({ host: 'localhost:4901', 'sec-fetch-site': 'same-site' })).toBe('cross-site post'); // localhost:4900, the app
    for (const origin of ['http://evil.example', 'http://localhost:4900', 'https://localhost:4901', 'null', 'not a url'])
      expect(post({ host: 'localhost:4901', origin }), origin).toBe('cross-site post');
  });
});
