import { describe, expect, it } from 'vitest';

import { RateLimiter } from '~/lib/rate-limit.server';

describe('RateLimiter', () => {
  it('allows up to the limit within a window', () => {
    const limiter = new RateLimiter(2, 1000);
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 10).allowed).toBe(true);
    expect(limiter.hit('a', 20)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.hit('b', 20).allowed).toBe(true);
  });

  it('starts over after the window', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.hit('a', 0);
    expect(limiter.hit('a', 500).allowed).toBe(false);
    expect(limiter.hit('a', 1000).allowed).toBe(true);
  });

  it('can be reset', () => {
    const limiter = new RateLimiter(1, 1000);
    limiter.hit('a', 0);
    limiter.reset('a');
    expect(limiter.hit('a', 1).allowed).toBe(true);
  });
});
