const DEV_SECRET = 'dev-only-session-secret-change-me-0123456789';

/** Reads the session secret, refusing to start in production with the default. */
export function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) {
    if (isSampleSessionSecret(secret)) warnSampleSecret();
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

/**
 * The compose file's `SESSION_SECRET` is a published sample (it has
 * `change-me` in it), so that `docker compose up` works on a laptop. Anyone
 * who read the repository can sign cookies with it. In production it is
 * allowed for a browser on the same machine only: the start log warns, and
 * `refuseSampleSecretOffLocalhost` answers every request that reached the
 * app under another host name.
 */
export function isSampleSessionSecret(secret = process.env.SESSION_SECRET ?? ''): boolean {
  return process.env.NODE_ENV === 'production' && /change-me/.test(secret);
}

let warned = false;
function warnSampleSecret() {
  if (warned) return;
  warned = true;
  console.warn(
    [
      '',
      '*****************************************************************',
      '* SESSION_SECRET is the sample value from docker-compose.yml.  *',
      '* Anyone can forge a session with it. It is accepted only for  *',
      '* requests to localhost; set your own SESSION_SECRET (16+      *',
      '* random characters) before serving the app to anyone else.    *',
      '*****************************************************************',
      '',
    ].join('\n'),
  );
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Throws a 503 for a request under a host name other than localhost while
 * the sample session secret is in use in production.
 */
export function refuseSampleSecretOffLocalhost(request: Request): void {
  if (!isSampleSessionSecret()) return;
  const host = new URL(request.url).hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return;
  throw new Response(
    'This server still uses the sample SESSION_SECRET from docker-compose.yml, which is only allowed on localhost. Set SESSION_SECRET to 16 or more random characters of your own.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
}
