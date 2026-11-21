import { describe, expect, it } from 'vitest';

import { signInKey } from '~/domain/sign-in-key';

describe('signInKey', () => {
  it('counts an email trimmed and in lower case', () => {
    expect(signInKey('  Ann@Example.COM ')).toBe('ann@example.com');
  });
});
