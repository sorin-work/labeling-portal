/**
 * Time-based one-time codes (RFC 6238 over RFC 4226): six digits, a new one
 * every 30 seconds, HMAC-SHA1, as every authenticator app does by default.
 * Pure apart from `node:crypto`; nothing here reads the clock or the
 * database.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Steps either side of now that still count, for a phone whose clock is a little off. */
export const DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the form authenticator apps take. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Reads base32, ignoring case, spaces and padding. Null for anything else. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, the RFC's recommendation), in base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step a moment falls in. */
export function timeStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS);
}

/** RFC 4226: the code for one counter value. */
export function hotp(key: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

/** The code a secret gives at a moment. */
export function totp(secret: string, now: Date, digits = DIGITS): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('The secret is not base32.');
  return hotp(key, timeStep(now), digits);
}

function sameCode(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Checks a code typed in at `now`. It may come from the step before or after
 * (`DRIFT_STEPS`), and its step must be later than `lastStep`, the step of
 * the last code that was accepted, so a code cannot be used twice. Returns
 * the step it matched, which the caller stores as the new `lastStep`.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null,
): { ok: true; step: number } | { ok: false; reason: 'format' | 'wrong' | 'used' } {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return { ok: false, reason: 'format' };
  const key = base32Decode(secret);
  if (!key) return { ok: false, reason: 'wrong' };
  const current = timeStep(now);
  let used = false;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (!sameCode(hotp(key, step), typed)) continue;
    if (lastStep !== null && step <= lastStep) {
      used = true;
      continue;
    }
    return { ok: true, step };
  }
  return { ok: false, reason: used ? 'used' : 'wrong' };
}

/** The `otpauth://` address an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'Labeling Portal'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The secret in groups of four, easier to type in by hand. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/**
 * Ten recovery codes like `k7mq-4xra-9tdp`: about 59 random bits each, in an
 * alphabet without letters that look alike. Shown once; only their hashes
 * are kept.
 */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

/** A recovery code as typed: lower case, without spaces and dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

/** What is stored for a recovery code: SHA-256 of the normalized code. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** Whether typed text looks like a recovery code rather than a six-digit code. */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z0-9]{12}$/.test(normalizeRecoveryCode(code));
}
