import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  otpauthUri,
  timeStep,
  totp,
  verifyTotp,
} from '~/domain/totp';

// the key of the RFC 4226 and RFC 6238 test vectors, "12345678901234567890"
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC_SECRET = base32Encode(RFC_KEY);

describe('hotp', () => {
  it('gives the RFC 4226 values', () => {
    expect(Array.from({ length: 10 }, (_, i) => hotp(RFC_KEY, i))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]);
  });
});

describe('totp', () => {
  it('gives the RFC 6238 values for SHA-1', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(totp(RFC_SECRET, new Date(seconds * 1000), 8), String(seconds)).toBe(code);
    }
  });

  it('round-trips base32 and ignores case and spaces', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_KEY);
    expect(base32Decode('not base32!')).toBeNull();
  });
});

describe('verifyTotp', () => {
  const now = new Date('2026-11-21T12:00:10Z');
  const step = timeStep(now);
  const at = (offset: number) => new Date(now.getTime() + offset * 30_000);

  it('takes the code of now and of one step either side, and says which step', () => {
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now), now, null)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(-1)), now, null)).toEqual({
      ok: true,
      step: step - 1,
    });
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(1)), now, null)).toEqual({
      ok: true,
      step: step + 1,
    });
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(2)), now, null)).toEqual({
      ok: false,
      reason: 'wrong',
    });
  });

  it('refuses a code whose step was used already, or an older one', () => {
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toEqual({ ok: false, reason: 'used' });
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at(-1)), now, step)).toEqual({
      ok: false,
      reason: 'used',
    });
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toEqual({ ok: true, step });
  });

  it('reads spaces in the code, and refuses what is not six digits', () => {
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now, null).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, '12345', now, null)).toEqual({ ok: false, reason: 'format' });
  });
});

describe('recovery codes and the setup address', () => {
  it('makes ten different codes that hash the same however they are typed', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      expect(looksLikeRecoveryCode(code.toUpperCase().replace(/-/g, ' '))).toBe(true);
      expect(hashRecoveryCode(code.toUpperCase())).toBe(hashRecoveryCode(code));
    }
    expect(looksLikeRecoveryCode('123456')).toBe(false);
  });

  it('names the issuer and the account in the otpauth address', () => {
    const uri = otpauthUri('ABCD', 'ann@example.test');
    expect(uri).toBe(
      'otpauth://totp/Labeling%20Portal%3Aann%40example.test?secret=ABCD&issuer=Labeling+Portal&algorithm=SHA1&digits=6&period=30',
    );
  });
});
