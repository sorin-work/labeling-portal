const DEV_SECRET = 'dev-only-session-secret-change-me-0123456789';

/** Reads the session secret, refusing to start in production with the default. */
export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set to at least 16 characters in production');
  }
  return DEV_SECRET;
}

export function cookieSecure(): boolean {
  const flag = process.env.COOKIE_SECURE;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV === 'production';
}
