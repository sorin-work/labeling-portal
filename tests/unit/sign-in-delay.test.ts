import { describe, expect, it } from 'vitest';

import { signInDelayMs, signInKey } from '~/domain/sign-in-delay';

describe('signInDelayMs', () => {
  it('is free for three attempts, then doubles from 250 ms up to five seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 50].map(signInDelayMs)).toEqual([
      0, 0, 0, 250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it('counts an email trimmed and in lower case', () => {
    expect(signInKey('  Ann@Example.COM ')).toBe('ann@example.com');
  });
});
