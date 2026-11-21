import { prisma, utc } from './db.server';

/**
 * Fixed-window rate limits whose counts live in PostgreSQL, in the UNLOGGED
 * table `RateLimitHit`, so that every app process counts together and a
 * restart does not clear a lockout. A window starts with the first attempt
 * of a key and lasts `windowMs`; the attempt after it starts a new one.
 *
 * One statement per attempt: an `INSERT ... ON CONFLICT DO UPDATE` that adds
 * one to the key's row, or starts the row over when its window is past, and
 * returns the count. Two processes counting the same key at once are put in
 * line by the row, so the count is exact and exactly one attempt sees
 * `limit + 1`: `justLocked` is true once per window.
 */
export class RateLimiter {
  constructor(
    /** names the limiter in the keys, so two limiters never share a count */
    private readonly name: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Records an attempt and says whether it is allowed. `justLocked` is true
   * for the first attempt that is refused in a window, so a lockout can be
   * recorded once.
   */
  async hit(
    key: string,
    now = Date.now(),
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; justLocked: boolean }> {
    const at = new Date(now);
    const until = new Date(now + this.windowMs);
    const [row] = await prisma.$queryRaw<Array<{ count: number; expiresAt: Date }>>`
      INSERT INTO "RateLimitHit" (key, count, "windowStart", "expiresAt")
      VALUES (${this.key(key)}, 1, ${utc(at)}, ${utc(until)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN 1
                     ELSE "RateLimitHit".count + 1 END,
        "windowStart" = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN ${utc(at)}
                             ELSE "RateLimitHit"."windowStart" END,
        "expiresAt" = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN ${utc(until)}
                           ELSE "RateLimitHit"."expiresAt" END
      RETURNING count, "expiresAt"`;
    await maybePrune(at);
    const count = Number(row.count);
    if (count === 1) return { allowed: true, retryAfterSeconds: 0, justLocked: false };
    return {
      allowed: count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((row.expiresAt.getTime() - now) / 1000)),
      justLocked: count === this.limit + 1,
    };
  }

  async reset(key: string): Promise<void> {
    await prisma.rateLimitHit.deleteMany({ where: { key: this.key(key) } });
  }

  private key(key: string): string {
    return `${this.name}:${key}`;
  }
}

/** Every this many attempts in a process, rows whose window is past are removed. */
export const PRUNE_EVERY = 1000;
let sincePrune = 0;

async function maybePrune(now: Date) {
  sincePrune += 1;
  if (sincePrune < PRUNE_EVERY) return;
  sincePrune = 0;
  await pruneRateLimits(now);
}

/** Removes the rows whose window is past. A key that comes back starts a new row. */
export async function pruneRateLimits(now = new Date()): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" <= ${utc(now)}`;
}

/** Ten failed sign-ins per email per fifteen minutes. */
export const loginLimiter = new RateLimiter('login', 10, 15 * 60_000);

/**
 * Five wrong second-step codes per account and client address per fifteen
 * minutes. With the address in the key, someone guessing from elsewhere does
 * not lock the owner out (see `clientAddress`).
 */
export const twoStepLimiter = new RateLimiter('two-step', 5, 15 * 60_000);

/**
 * Twenty wrong second-step codes per account per hour, wherever they come
 * from: a cap for someone who has the password and many addresses (or a
 * header to fake one). It can hold the owner off too, which is acceptable at
 * this step, since only someone who knows the password reaches it.
 */
export const twoStepAccountLimiter = new RateLimiter('two-step-account', 20, 60 * 60_000);
