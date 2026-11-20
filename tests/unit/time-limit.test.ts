import { describe, expect, it } from 'vitest';

import { CREDIT_WINDOW_MS, firstSubmissionCap } from '~/domain/active-time';
import {
  extensionsLeft,
  inExtendWindow,
  MAX_CLAIM_MS,
  MAX_EXTENSIONS,
  timeAnnouncement,
} from '~/domain/time-limit';

const min = 60_000;

describe('timeAnnouncement', () => {
  it('speaks when a moment is crossed, once', () => {
    expect(timeAnnouncement(10 * min + 500, 10 * min - 500)).toBe('10 minutes left on this task.');
    expect(timeAnnouncement(10 * min - 500, 10 * min - 1500)).toBeNull();
    expect(timeAnnouncement(5 * min + 1, 5 * min)).toBe('5 minutes left on this task.');
    expect(timeAnnouncement(min + 1, min)).toBe('One minute left on this task.');
  });

  it('leaves two minutes to the warning', () => {
    expect(timeAnnouncement(2 * min + 1, 2 * min - 1)).toBeNull();
  });

  it('says the smallest moment when a jump crosses several', () => {
    expect(timeAnnouncement(11 * min, 4 * min)).toBe('5 minutes left on this task.');
  });

  it('says when the time is up', () => {
    expect(timeAnnouncement(500, -500)).toBe('Time is up. The task goes back to the queue.');
    expect(timeAnnouncement(-500, -1500)).toBeNull();
  });

  it('says nothing while time is added (an extension)', () => {
    expect(timeAnnouncement(90_000, 31 * min)).toBeNull();
  });
});

describe('extensionsLeft', () => {
  it('counts down from three and stops at none', () => {
    expect(MAX_EXTENSIONS).toBe(3);
    expect(extensionsLeft(0)).toBe(3);
    expect(extensionsLeft(3)).toBe(0);
    expect(extensionsLeft(5)).toBe(0);
  });
});

describe('the extension window', () => {
  const end = new Date('2026-01-10T09:30:00Z');
  const before = (ms: number) => new Date(end.getTime() - ms);

  it('opens two minutes before the end and closes with it', () => {
    expect(inExtendWindow(end, before(2 * min + 1))).toBe(false);
    expect(inExtendWindow(end, before(2 * min))).toBe(true);
    expect(inExtendWindow(end, before(1))).toBe(true);
    expect(inExtendWindow(end, end)).toBe(false);
  });
});

describe('credit and the longest claim', () => {
  it('reaches back as far as a claim of 480 minutes with every extension can live', () => {
    expect(MAX_CLAIM_MS).toBe(480 * 4 * min);
    expect(CREDIT_WINDOW_MS).toBeGreaterThanOrEqual(MAX_CLAIM_MS);
  });

  it('credits a first submission two time limits at most', () => {
    expect(firstSubmissionCap(30)).toBe(3600);
    expect(firstSubmissionCap(480)).toBe(2 * 480 * 60);
    expect(firstSubmissionCap(Number.NaN)).toBe(0);
  });
});
