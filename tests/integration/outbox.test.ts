import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceClock } from '@/core/clock';
import { dbSystem as db } from '@/core/db/system'; // fixtures run as the owner role (RLS enforce leg)
import { env } from '@/core/env';
import { drainOutbox, enqueue, LEASE_MS, MAX_ATTEMPTS, sweepOutbox } from '@/modules/notifications/outbox';
import { sendSms } from '@/modules/notifications/sms';
import { resetAuthTables } from '../helpers/auth';

// A controllable slow provider: delays the real (capturing) send.
const sendDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock('@/core/email/transport', async (orig) => {
  const real = await orig<typeof import('@/core/email/transport')>();
  return { ...real, sendEmail: async (...a: Parameters<typeof real.sendEmail>) => { await new Promise((r) => setTimeout(r, sendDelay.ms)); return real.sendEmail(...a); } };
});

beforeEach(async () => {
  await resetAuthTables();
  sendDelay.ms = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const email = { channel: 'email', to: 'ada@example.test', template: 'notice', data: { subject: 'Hi', body: 'SECRET-BODY' } } as const;

describe('outbox drain', () => {
  it('sends a due message once and marks it sent', async () => {
    await enqueue(email);
    expect(await drainOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(await db.capturedMessage.findFirst()).toMatchObject({ to: email.to, subject: 'Hi', body: 'SECRET-BODY' });
    expect((await db.outbox.findFirstOrThrow()).sentAt).not.toBeNull();
  });

  it('leaves a message scheduled for later until it is due', async () => {
    await enqueue({ ...email, sendAfter: new Date(Date.now() + 3_600_000) });
    expect((await drainOutbox()).sent).toBe(0);
    advanceClock(2 * 3_600_000);
    expect((await drainOutbox()).sent).toBe(1);
  });

  it('two overlapping drains send each message once', async () => {
    for (let i = 0; i < 6; i++) await enqueue(email);
    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()]);
    expect(a.sent + b.sent).toBe(6);
    expect(await db.capturedMessage.count()).toBe(6);
  });

  // A row whose template no longer exists fails inside the drain: the simplest real failure.
  const broken = () => db.outbox.create({ data: { channel: 'email', to: email.to, template: 'gone', data: {} } });

  it('a failure backs off, records the error, and gives up after MAX_ATTEMPTS', async () => {
    await broken();
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 0 }); // backed off, not retried immediately
    for (let i = 1; i <= MAX_ATTEMPTS + 2; i++) {
      advanceClock(i * 3 * 3_600_000);
      await drainOutbox();
    }
    expect(await db.outbox.findFirstOrThrow()).toMatchObject({ sentAt: null, attempts: MAX_ATTEMPTS, lastError: 'Unknown notification template: gone' });
  });

  it('one failing row does not block the ones behind it', async () => {
    await broken();
    await enqueue(email);
    expect(await drainOutbox()).toEqual({ sent: 1, failed: 1 });
  });

  // FR-01: the send used to run inside the claim's interactive transaction (5s default timeout).
  // A slower send was delivered, then the bookkeeping hit a closed tx: never marked, re-sent every run.
  it('a send slower than a transaction timeout is still recorded as sent, once', async () => {
    sendDelay.ms = 5_500;
    await enqueue(email);
    expect(await drainOutbox()).toEqual({ sent: 1, failed: 0 });
    expect(await db.outbox.findFirstOrThrow()).toMatchObject({ attempts: 1, lastError: null, sentAt: expect.any(Date) });
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(await db.capturedMessage.count()).toBe(1);
  }, 20_000);

  it('a row being sent is leased: an overlapping drain does not take it', async () => {
    sendDelay.ms = 500;
    await enqueue(email);
    const first = drainOutbox();
    await new Promise((r) => setTimeout(r, 200));
    expect(await drainOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(await first).toEqual({ sent: 1, failed: 0 });
    expect(await db.capturedMessage.count()).toBe(1);
  });

  it('a crash after the claim retries the row once the lease runs out', async () => {
    await enqueue(email);
    await db.outbox.updateMany({ data: { attempts: 1, sendAfter: new Date(Date.now() + LEASE_MS) } }); // claimed, then crashed
    expect((await drainOutbox()).sent).toBe(0);
    advanceClock(LEASE_MS + 1_000);
    expect((await drainOutbox()).sent).toBe(1);
  });

  it('rejects an unknown template at enqueue', async () => {
    await expect(enqueue({ ...email, template: 'nope' })).rejects.toThrow(/Unknown notification template/);
    expect(await db.outbox.count()).toBe(0);
  });

  it('sweeps sent rows after a week, keeps unsent ones', async () => {
    await enqueue(email);
    await drainOutbox();
    await enqueue(email);
    advanceClock(8 * 86_400_000);
    expect(await sweepOutbox()).toBe(1);
    expect(await db.outbox.count()).toBe(1);
  });
});

describe('sms transport', () => {
  const msg = { to: '+15551234567', body: 'SECRET-BODY' };
  const base = { ...env, VERCEL_ENV: undefined, SMS_SANDBOX_TO: undefined, SMS_ENABLED: undefined };

  it('outside production: captures, no fetch, logs neither body nor number', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await sendSms(msg, base);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.capturedMessage.findFirst()).toMatchObject({ to: msg.to, body: msg.body });
    const logged = logSpy.mock.calls.flat().join('\n');
    expect(logged).not.toContain('SECRET-BODY');
    expect(logged).not.toContain(msg.to);
  });

  it('the kill switch sends and captures nothing', async () => {
    await sendSms(msg, { ...base, SMS_ENABLED: '0' });
    expect(await db.capturedMessage.count()).toBe(0);
  });

  it('the sandbox really sends, but only to SMS_SANDBOX_TO', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await sendSms(msg, { ...base, VERCEL_ENV: 'preview', SMS_SANDBOX_TO: '+15559999999', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15550000' });
    expect(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).toContain('To=%2B15559999999');
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal); // FR-01
  });

  it('a provider that is not configured throws', async () => {
    await expect(sendSms(msg, { ...base, VERCEL_ENV: 'production' })).rejects.toThrow(/not configured/);
  });
});
