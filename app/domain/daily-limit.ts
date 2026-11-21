import { spokenDuration } from './release-claim';

/**
 * The daily task limit of a project (`Project.dailyTaskLimit`): how many
 * tasks one person may hand in there per UTC day. A claim that is still open
 * counts as well, so the limit is never passed by the task somebody is
 * working on. Skips do not count: a skip earns nothing.
 */

export const MAX_DAILY_TASK_LIMIT = 10_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Reads the field of the project form. Empty is no limit. */
export function parseDailyTaskLimit(raw: unknown): Parsed<number | null> {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DAILY_TASK_LIMIT) {
    return {
      ok: false,
      error: `The daily limit must be a whole number from 1 to ${MAX_DAILY_TASK_LIMIT}, or empty`,
    };
  }
  return { ok: true, value };
}

/** Midnight UTC at the start of the day `now` is in. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Midnight UTC at the start of the next day. */
export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Whether someone who handed in `submittedToday` tasks and holds `open`
 * claims may take one more. No limit always says yes.
 */
export function underLimit(limit: number | null, submittedToday: number, open: number): boolean {
  return limit === null || submittedToday + open < limit;
}

/** What the project page says to someone who reached the limit. */
export function limitReachedMessage(limit: number | null, now: Date): string {
  const count =
    limit === null
      ? 'the daily limit'
      : `the daily limit of ${limit} task${limit === 1 ? '' : 's'}`;
  const left = spokenDuration((nextUtcDay(now).getTime() - now.getTime()) / 1000);
  return `You reached ${count} in this project. The next day starts at midnight UTC, in ${left}.`;
}
