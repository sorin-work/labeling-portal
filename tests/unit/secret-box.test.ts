import { afterEach, describe, expect, it } from 'vitest';

import { openSecret, sealSecret } from '~/lib/secret-box.server';

describe('secret box', () => {
  const saved = process.env.TOTP_KEY;
  afterEach(() => {
    process.env.TOTP_KEY = saved;
  });

  it('gives the secret back, and a new sealed value each time', () => {
    process.env.TOTP_KEY = 'a-key-of-sixteen-or-more';
    const a = sealSecret('GEZDGNBVGY3TQOJQ');
    const b = sealSecret('GEZDGNBVGY3TQOJQ');
    expect(a).not.toBe(b);
    expect(a).not.toContain('GEZDGNBVGY3TQOJQ');
    expect(openSecret(a)).toBe('GEZDGNBVGY3TQOJQ');
  });

  it('refuses a value made with another key or changed', () => {
    process.env.TOTP_KEY = 'a-key-of-sixteen-or-more';
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ');
    const [v, iv, tag, body] = sealed.split('.');
    const flipped = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    expect(openSecret([v, iv, tag, flipped].join('.'))).toBeNull();
    process.env.TOTP_KEY = 'another-key-of-sixteen-chars';
    expect(openSecret(sealed)).toBeNull();
    expect(openSecret('nonsense')).toBeNull();
  });
});
