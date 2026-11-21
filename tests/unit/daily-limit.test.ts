import { describe, expect, it } from 'vitest';

import {
  limitReachedMessage,
  nextUtcDay,
  parseDailyTaskLimit,
  startOfUtcDay,
  underLimit,
} from '~/domain/daily-limit';
import { releaseConfirmation, spokenDuration } from '~/domain/release-claim';
import { queueMessage } from '~/lib/queue-messages';

describe('the daily task limit', () => {
  it('reads the form field, empty being no limit', () => {
    expect(parseDailyTaskLimit('')).toEqual({ ok: true, value: null });
    expect(parseDailyTaskLimit(null)).toEqual({ ok: true, value: null });
    expect(parseDailyTaskLimit(' 40 ')).toEqual({ ok: true, value: 40 });
    for (const bad of ['0', '-3', '2.5', 'ten', '10001']) {
      expect(parseDailyTaskLimit(bad).ok).toBe(false);
    }
  });

  it('counts the day in UTC', () => {
    const late = new Date('2026-03-02T23:59:59Z');
    expect(startOfUtcDay(late).toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(nextUtcDay(late).toISOString()).toBe('2026-03-03T00:00:00.000Z');
    expect(nextUtcDay(new Date('2026-12-31T12:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('counts submissions and held claims together', () => {
    expect(underLimit(null, 500, 1)).toBe(true);
    expect(underLimit(3, 2, 0)).toBe(true);
    expect(underLimit(3, 2, 1)).toBe(false);
    expect(underLimit(3, 3, 0)).toBe(false);
  });

  it('says when the next day starts', () => {
    const now = new Date('2026-03-02T20:47:30Z');
    expect(limitReachedMessage(40, now)).toBe(
      'You reached the daily limit of 40 tasks in this project. The next day starts at midnight UTC, in 3 hours 12 minutes.',
    );
    expect(queueMessage('limit', { dailyTaskLimit: 1, now })).toContain('limit of 1 task in');
    expect(queueMessage('empty', { dailyTaskLimit: 1, now })).toBe(
      'There are no more tasks for you in this project right now.',
    );
  });
});

describe('releasing a claim', () => {
  const base = {
    annotator: 'Ann',
    claimedAt: new Date('2026-03-02T08:00:00Z'),
    now: new Date('2026-03-02T10:05:00Z'),
  };

  it('says how long the claim ran, whether a draft is lost and what is paid', () => {
    expect(
      releaseConfirmation({ ...base, hasDraft: true, draftSeconds: 41 * 60, payMode: 'HOURLY' }),
    ).toBe(
      'Ann claimed this task 2 hours 5 minutes ago. Their draft is thrown away and the task goes back to the queue. Their draft saves recorded 41 minutes of work, which is credited to them as on a submission. Release the claim?',
    );
    expect(
      releaseConfirmation({ ...base, hasDraft: true, draftSeconds: 600, payMode: 'PER_TASK' }),
    ).toContain('This project pays per accepted task, so that time is not paid.');
    expect(
      releaseConfirmation({ ...base, hasDraft: false, draftSeconds: 0, payMode: 'HOURLY' }),
    ).toBe(
      'Ann claimed this task 2 hours 5 minutes ago. They saved no draft. The task goes back to the queue. Release the claim?',
    );
  });

  it('speaks durations in whole minutes', () => {
    expect(spokenDuration(30)).toBe('less than a minute');
    expect(spokenDuration(60)).toBe('1 minute');
    expect(spokenDuration(3600)).toBe('1 hour');
    expect(spokenDuration(3 * 3600 + 120)).toBe('3 hours 2 minutes');
  });
});
