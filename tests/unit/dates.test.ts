import { describe, expect, it } from 'vitest';

import { currentMonth, parseDay, readRange, toDay } from '~/lib/dates';
import { formatDate, formatDateTime, formatRelative, titleCase } from '~/lib/format';

describe('parseDay', () => {
  it('accepts real calendar days', () => {
    expect(parseDay('2026-02-28')).toBe('2026-02-28');
    expect(parseDay('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects impossible or malformed days', () => {
    expect(parseDay('2026-02-29')).toBeNull();
    expect(parseDay('2026-13-01')).toBeNull();
    expect(parseDay('26-01-01')).toBeNull();
    expect(parseDay(null)).toBeNull();
  });
});

describe('currentMonth', () => {
  it('returns the first and last day in UTC', () => {
    expect(currentMonth(new Date('2026-02-14T23:30:00Z'))).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(currentMonth(new Date('2026-12-31T23:59:00Z'))).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('readRange', () => {
  it('falls back to the month and orders the ends', () => {
    const now = new Date('2026-07-10T12:00:00Z');
    expect(readRange(new URL('http://x/payouts'), now)).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(readRange(new URL('http://x/?from=2026-07-20&to=2026-07-02'), now)).toEqual({
      from: '2026-07-02',
      to: '2026-07-20',
    });
  });
});

describe('formatting', () => {
  it('formats dates in UTC', () => {
    expect(toDay(new Date('2026-03-05T23:59:59Z'))).toBe('2026-03-05');
    expect(formatDate('2026-03-05T23:59:59Z')).toBe('5 Mar 2026');
    expect(formatDateTime('2026-03-05T08:07:00Z')).toBe('5 Mar, 08:07 UTC');
  });

  it('turns enum values into words', () => {
    expect(titleCase('SENT_BACK')).toBe('Sent back');
    expect(titleCase('ACTIVE')).toBe('Active');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  it('uses words for recent times', () => {
    expect(formatRelative('2026-09-22T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-09-22T11:50:00Z', now)).toBe('10 minutes ago');
    expect(formatRelative('2026-09-22T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatRelative('2026-09-21T10:00:00Z', now)).toBe('yesterday');
    expect(formatRelative('2026-09-22T12:05:00Z', now)).toBe('in 5 minutes');
  });

  it('falls back to a date after a week', () => {
    expect(formatRelative('2026-09-01T12:00:00Z', now)).toBe('1 Sept 2026');
  });
});
