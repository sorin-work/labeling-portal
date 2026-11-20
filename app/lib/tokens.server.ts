import { createHash, randomBytes } from 'node:crypto';

/** Every token starts with this, so one that leaks into a log or a repository is easy to spot. */
export const TOKEN_PREFIX = 'lp_';

/** The SHA-256 of a token, which is all the database keeps of it. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 random bytes behind the prefix. */
export function newToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}
