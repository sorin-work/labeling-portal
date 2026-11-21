const DEV_SECRET = 'dev-only-session-secret-change-me-0123456789';

/** Reads the session secret, refusing to start in production with the default. */
export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) {
    // a published sample is no secret: anyone who read the repository could
    // sign cookies with it
    if (process.env.NODE_ENV === 'production' && /change-me/.test(secret)) {
      throw new Error(
        'SESSION_SECRET is a published sample value. Leave it unset in docker compose (a random one is made on first start) or set 16 or more random characters of your own.',
      );
    }
    return secret;
  }
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

/**
 * Hosts inside the network that box projects may load images from, from
 * `INTERNAL_IMAGE_HOSTS` (comma separated, for example
 * `images.internal,10.0.0.5`). Empty by default: an image address on a
 * loopback, private or link-local address or a local name is refused.
 */
export function internalImageHosts(): string[] {
  return (process.env.INTERNAL_IMAGE_HOSTS ?? '')
    .split(',')
    .map((host) =>
      host
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, ''),
    )
    .filter(Boolean);
}

const DEV_TOTP_KEY = 'dev-only-totp-key-change-me-0123456789';

/**
 * The key the two-step secrets are encrypted with, from `TOTP_KEY` (16 or
 * more characters). It is its own variable so that rotating the session
 * secret does not make every second step unreadable. Production asks for it
 * only when someone sets up or uses a second step, so an install that does
 * not use the feature needs nothing new.
 */
export function totpKey(): string {
  const key = process.env.TOTP_KEY;
  const production = process.env.NODE_ENV === 'production';
  // a published sample value is no key: everyone who read the repository has it
  const sample = !!key && /change-me/.test(key);
  if (key && key.length >= 16 && !(production && sample)) return key;
  if (production) throw new TotpKeyMissing();
  return DEV_TOTP_KEY;
}

export class TotpKeyMissing extends Error {
  constructor() {
    super(
      'TOTP_KEY must be set to at least 16 characters of your own (not a sample value) to use two-step sign-in',
    );
  }
}

/**
 * Whether the app sits behind a proxy that says who the client is
 * (`TRUST_PROXY=true`). Only then is `X-Forwarded-For` believed.
 */
export function trustProxy(): boolean {
  return process.env.TRUST_PROXY === 'true';
}
