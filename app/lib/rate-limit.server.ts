/**
 * Small in-memory fixed-window limiter. Good enough for a single app
 * instance; counts reset when the process restarts.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Records an attempt and says whether it is allowed. `justLocked` is true
   * for the first attempt that is refused in a window, so a lockout can be
   * recorded once.
   */
  hit(
    key: string,
    now = Date.now(),
  ): { allowed: boolean; retryAfterSeconds: number; justLocked: boolean } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return { allowed: true, retryAfterSeconds: 0, justLocked: false };
    }
    entry.count += 1;
    return {
      allowed: entry.count <= this.limit,
      retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
      justLocked: entry.count === this.limit + 1,
    };
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private prune(now: number) {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}

/** Ten failed sign-ins per email per fifteen minutes. */
export const loginLimiter = new RateLimiter(10, 15 * 60_000);

/**
 * Five wrong second-step codes per account and client address per fifteen
 * minutes. With the address in the key, someone guessing from elsewhere does
 * not lock the owner out (see `clientAddress`).
 */
export const twoStepLimiter = new RateLimiter(5, 15 * 60_000);
