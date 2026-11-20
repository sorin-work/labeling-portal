import { describe, expect, it } from 'vitest';

import { extensionsLeft, MAX_EXTENSIONS, timeAnnouncement } from '~/domain/time-limit';

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
