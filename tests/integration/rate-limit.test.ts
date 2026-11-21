import { beforeEach, describe, expect, it } from 'vitest';

import { pruneRateLimits, RateLimiter } from '~/lib/rate-limit.server';

import { prisma, resetDb } from './helpers';

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
    expect((await prisma.rateLimitHit.findMany()).map((r) => r.key)).toEqual(['test:new']);
  });
});
