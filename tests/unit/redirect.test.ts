import { describe, expect, it } from 'vitest';

import { safeRedirect } from '~/lib/redirect';

describe('safeRedirect', () => {
  it('keeps local paths', () => {
    expect(safeRedirect('/projects/abc?tab=batches')).toBe('/projects/abc?tab=batches');
  });

  it('falls back for absolute and protocol-relative urls', () => {
    expect(safeRedirect('https://evil.test')).toBe('/');
    expect(safeRedirect('//evil.test')).toBe('/');
    expect(safeRedirect('/\\evil.test')).toBe('/');
  });

  it('falls back for missing values', () => {
    expect(safeRedirect(null, '/home')).toBe('/home');
    expect(safeRedirect('', '/home')).toBe('/home');
  });
});
