import { describe, expect, it } from 'vitest';

import { errorText, retryDelayMs } from '~/domain/jobs';

describe('retryDelayMs', () => {
  it('doubles from half a minute and stops at an hour', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(retryDelayMs(0)).toBe(30_000);
  });
});

describe('errorText', () => {
  it('keeps the first line, short', () => {
    expect(errorText(new Error('one\ntwo'))).toBe('one');
    expect(errorText('x'.repeat(900))).toHaveLength(500);
    expect(errorText(new Error(''))).toBe('failed');
  });
});
