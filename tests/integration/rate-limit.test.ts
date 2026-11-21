import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneRateLimits, rateLimitHash, RateLimiter } from '~/lib/rate-limit.server';
import { action as loginAction } from '~/routes/login';

import { createMember, createOrg, makeRequest, prisma, resetDb, run, statusOf } from './helpers';

const t0 = Date.parse('2026-11-21T12:00:00Z');

describe('rate limits in the database', () => {
  beforeEach(resetDb);

  it('allows up to the limit within a window and reports the lockout once', async () => {
    const limiter = new RateLimiter('test', 2, 1000);
    expect((await limiter.hit('a', t0)).allowed).toBe(true);
    expect((await limiter.hit('a', t0 + 10)).allowed).toBe(true);
    expect(await limiter.hit('a', t0 + 20)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
      justLocked: true,
    });
    expect((await limiter.hit('a', t0 + 30)).justLocked).toBe(false);
    expect((await limiter.hit('b', t0 + 20)).allowed).toBe(true);
  });

  it('is shared between two limiters of the same name, as between two processes', async () => {
    const first = new RateLimiter('shared', 3, 60_000);
    const second = new RateLimiter('shared', 3, 60_000);
    await first.hit('ann', t0);
    await second.hit('ann', t0 + 1);
    await first.hit('ann', t0 + 2);
    const refused = await second.hit('ann', t0 + 3);
    expect(refused).toMatchObject({ allowed: false, justLocked: true });
    // a limiter of another name counts on its own
    expect((await new RateLimiter('other', 3, 60_000).hit('ann', t0 + 4)).allowed).toBe(true);
  });

  it('reports the lockout to exactly one of many attempts at once', async () => {
    const limiters = Array.from({ length: 4 }, () => new RateLimiter('race', 5, 60_000));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => limiters[i % 4].hit('key', t0 + i)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => r.justLocked)).toHaveLength(1);
  });

  it('starts over after the window, and can be reset', async () => {
    const limiter = new RateLimiter('test', 1, 1000);
    await limiter.hit('a', t0);
    expect((await limiter.hit('a', t0 + 500)).allowed).toBe(false);
    expect((await limiter.hit('a', t0 + 1000)).allowed).toBe(true);
    await limiter.reset('a');
    expect((await limiter.hit('a', t0 + 1001)).allowed).toBe(true);
  });

  it('removes rows whose window is past', async () => {
    const limiter = new RateLimiter('test', 1, 1000);
    await limiter.hit('old', t0);
    await limiter.hit('new', t0 + 5000);
    expect(await pruneRateLimits(new Date(t0 + 2000))).toBe(1);
    expect((await prisma.rateLimitHit.findMany()).map((r) => r.key)).toEqual([
      rateLimitHash('test:new'),
    ]);
  });

  it('stores keys hashed, whatever their length, and peeks without counting', async () => {
    const limiter = new RateLimiter('test', 5, 1000);
    const long = 'x'.repeat(5000);
    await limiter.hit(long, t0, '203.0.113.9');
    const [row] = await prisma.rateLimitHit.findMany();
    expect(row).toMatchObject({ name: 'test', subject: rateLimitHash(long) });
    expect(row.key).toHaveLength(64);
    expect(await limiter.peek(long, t0 + 1, '203.0.113.9')).toEqual({
      count: 1,
      retryAfterSeconds: 1,
    });
    expect((await limiter.peek(long, t0 + 1, '203.0.113.9')).count).toBe(1);
    expect((await limiter.peek(long, t0 + 1)).count).toBe(0);
  });
});

describe('the sign-in limit', () => {
  beforeEach(resetDb);
  const saved = process.env.TRUST_PROXY;
  afterEach(() => {
    process.env.TRUST_PROXY = saved;
  });

  const signIn = (email: string, password: string, from?: string) =>
    run(
      loginAction,
      makeRequest('/login', {
        form: { email, password },
        headers: from ? { 'X-Forwarded-For': from } : undefined,
      }),
    );

  it('does not let an address hammering an email stop its owner elsewhere', async () => {
    process.env.TRUST_PROXY = 'true';
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', {
      email: 'owner@example.test',
      password: 'right-pass',
    });
    for (let i = 0; i < 40; i += 1) await signIn('owner@example.test', 'wrong', '203.0.113.66');
    // the attacker's address is locked, with the right password too
    expect(statusOf(await signIn('owner@example.test', 'right-pass', '203.0.113.66'))).toBe(429);
    // the owner from home signs in
    expect(statusOf(await signIn('owner@example.test', 'right-pass', '198.51.100.4'))).toBe(302);
    expect(await prisma.activity.count({ where: { action: 'auth.locked' } })).toBe(1);
  });

  it('gives a new address fewer tries while an email is guessed at from many', async () => {
    process.env.TRUST_PROXY = 'true';
    const org = await createOrg();
    await createMember(org.id, 'ANNOTATOR', { email: 'busy@example.test', password: 'right-pass' });
    // thirty wrong passwords from three addresses, under each address's limit
    for (let a = 0; a < 3; a += 1) {
      for (let i = 0; i < 10; i += 1) await signIn('busy@example.test', 'wrong', `203.0.113.${a}`);
    }
    const fresh = '192.0.2.50';
    for (let i = 0; i < 3; i += 1) {
      expect(statusOf(await signIn('busy@example.test', 'wrong', fresh))).toBe(401);
    }
    expect(statusOf(await signIn('busy@example.test', 'wrong', fresh))).toBe(429);
    // a right password from yet another address still signs in on its first try
    expect(statusOf(await signIn('busy@example.test', 'right-pass', '192.0.2.99'))).toBe(302);
  });

  it('answers 400 for an email longer than any real one, without a lookup or a row', async () => {
    const result = await signIn(`${'a'.repeat(3000)}@example.test`, 'whatever');
    expect(statusOf(result)).toBe(400);
    expect(await prisma.rateLimitHit.count()).toBe(0);
  });
});
