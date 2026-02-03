import { describe, expect, it } from 'vitest';

import { formatDuration } from '~/components/use-active-time';

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 07m');
  });

  it('never shows negative time', () => {
    expect(formatDuration(-10)).toBe('0s');
  });
});
