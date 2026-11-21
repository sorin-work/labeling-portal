import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { totpKey } from './env.server';

/**
 * Encrypts the two-step secrets at rest with AES-256-GCM under a key made
 * from `TOTP_KEY`. A secret has to be read back to check a code, so it
 * cannot be hashed like a password. Stored as `v1.<iv>.<tag>.<ciphertext>`
 * in base64url; the tag makes a changed or mixed-up value fail instead of
 * decrypting to something else. A database dump alone does not give the
 * secrets away.
 */
function key(): Buffer {
  return createHash('sha256').update(`labeling-portal totp ${totpKey()}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/** The secret, or null when the value was made with another key or changed. */
export function openSecret(sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
