import { createHash } from 'node:crypto';

import { prisma, utc } from './db.server';

/** What is stored for a key: hex SHA-256, so the row's key has a fixed length. */
export function rateLimitHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

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
    /** a second part of the key, such as the client address, left out of `subject` */
    detail?: string,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number; justLocked: boolean; count: number }> {
    const at = new Date(now);
    const until = new Date(now + this.windowMs);
    const [row] = await prisma.$queryRaw<Array<{ count: number; expiresAt: Date }>>`
      INSERT INTO "RateLimitHit" (key, name, subject, count, "windowStart", "expiresAt")
      VALUES (${this.key(key, detail)}, ${this.name}, ${rateLimitHash(key)}, 1, ${utc(at)}, ${utc(until)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN 1
                     ELSE "RateLimitHit".count + 1 END,
        "windowStart" = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN ${utc(at)}
                             ELSE "RateLimitHit"."windowStart" END,
        "expiresAt" = CASE WHEN "RateLimitHit"."expiresAt" <= ${utc(at)} THEN ${utc(until)}
                           ELSE "RateLimitHit"."expiresAt" END
      RETURNING count, "expiresAt"`;
    maybePrune(at);
    const count = Number(row.count);
    if (count === 1) return { allowed: true, retryAfterSeconds: 0, justLocked: false, count };
    return {
      allowed: count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((row.expiresAt.getTime() - now) / 1000)),
      justLocked: count === this.limit + 1,
      count,
    };
  }

  /**
   * The count of a key in its current window without adding to it, and how
   * long that window still runs. 0 for a key with no row or a past window.
   */
  async peek(
    key: string,
    now = Date.now(),
    detail?: string,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const row = await prisma.rateLimitHit.findUnique({ where: { key: this.key(key, detail) } });
    if (!row || row.expiresAt.getTime() <= now) return { count: 0, retryAfterSeconds: 0 };
    return {
      count: row.count,
      retryAfterSeconds: Math.max(1, Math.ceil((row.expiresAt.getTime() - now) / 1000)),
    };
  }

  async reset(key: string, detail?: string): Promise<void> {
    await prisma.rateLimitHit.deleteMany({ where: { key: this.key(key, detail) } });
  }

  get limitPerWindow(): number {
    return this.limit;
  }

  private key(key: string, detail?: string): string {
    return rateLimitHash(`${this.name}:${key}${detail === undefined ? '' : `|${detail}`}`);
  }
}

/** Every this many attempts in a process, rows whose window is past are removed. */
export const PRUNE_EVERY = 1000;
let sincePrune = 0;

/** Not awaited: a failed clean-up is logged and never fails the attempt that ran it. */
function maybePrune(now: Date) {
  sincePrune += 1;
  if (sincePrune < PRUNE_EVERY) return;
  sincePrune = 0;
  pruneRateLimits(now).catch((error: unknown) =>
    console.error('could not remove old rate limit rows', error),
  );
}

/** Removes the rows whose window is past. A key that comes back starts a new row. */
export async function pruneRateLimits(now = new Date()): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "RateLimitHit" WHERE "expiresAt" <= ${utc(now)}`;
}

/**
 * Ten wrong passwords per email and client address per fifteen minutes. Only
 * wrong passwords count, and a right one from an address that is not locked
 * always signs in, so someone hammering an email from one place does not
 * lock its owner out elsewhere.
 */
export const loginLimiter = new RateLimiter('login', 10, 15 * 60_000);

/**
 * Wrong passwords for an email from anywhere. Past this many in fifteen
 * minutes, every address gets only `BUSY_EMAIL_TRIES` wrong passwords of its
 * own instead of ten, which slows guessing from many addresses. Nobody is
 * locked out by others: an address that has not been wrong itself still
 * signs in with the right password.
 */
export const loginEmailLimiter = new RateLimiter('login-email', 30, 15 * 60_000);
export const BUSY_EMAIL_TRIES = 3;

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
