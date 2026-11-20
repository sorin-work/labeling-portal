/**
 * How much working time the server credits. The browser reports the seconds,
 * so every number that comes in is cut down here to what can be true.
 */

/** Time is reported by the browser; never credit more than has actually passed. */
export function clampActiveSeconds(reported: number, since: Date, now: Date): number {
  const elapsed = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  if (!Number.isFinite(reported) || reported < 0) return 0;
  return Math.min(Math.floor(reported), elapsed);
}

import { MAX_CLAIM_MS } from './time-limit';

/**
 * However often work is sent back, one assignment is never credited more than
 * this many of its project's time limits in total. A first submission is at
 * most `FIRST_SUBMISSION_LIMITS`, which leaves one for revising.
 */
export const MAX_CREDITED_LIMITS = 3;

/**
 * The most time limits a first submission is credited, however many
 * extensions the claim got. Extensions give the time to finish; the credit
 * stays where it was when one extension was all there was, so the total
 * above still holds.
 */
export const FIRST_SUBMISSION_LIMITS = 2;

/**
 * What the extend button says on an hourly project: extensions are time to
 * finish, and what is worked past the first submission's cap is not paid.
 * Null on a project paid per task, where time does not change the pay.
 */
export function extensionPayNote(
  limitMinutes: number,
  payMode: 'PER_TASK' | 'HOURLY',
): string | null {
  if (payMode !== 'HOURLY') return null;
  const paid = Math.max(0, Math.floor(limitMinutes)) * FIRST_SUBMISSION_LIMITS;
  return `Extra time to finish; time beyond ${paid} minutes is not paid.`;
}

/** The cap of a first submission, in seconds, for a project's time limit in minutes. */
export function firstSubmissionCap(limitMinutes: number): number {
  return Number.isFinite(limitMinutes)
    ? Math.max(0, Math.floor(limitMinutes)) * 60 * FIRST_SUBMISSION_LIMITS
    : 0;
}

/**
 * The most seconds one revision of sent-back work can get. A first
 * submission is bounded by its claim: after the time limit the claim is gone.
 * Revising has no claim and no deadline, so the same bound is set by hand:
 * the project's time limit for one revision, and what is left of
 * MAX_CREDITED_LIMITS time limits for the assignment as a whole. Every
 * project has a time limit (1 to 480 minutes), so there is always a bound.
 */
export function revisionCap(limitSeconds: number, credited: number): number {
  // a limit or a total that is not a number bounds nothing, so it allows nothing
  const limit = Number.isFinite(limitSeconds) ? Math.max(0, Math.floor(limitSeconds)) : 0;
  const left = Number.isFinite(credited)
    ? Math.max(0, MAX_CREDITED_LIMITS * limit - Math.ceil(credited))
    : 0;
  return Math.min(limit, left);
}

/**
 * The seconds a revision can show for itself: not more than the time since
 * the review and not more than `revisionCap`. This is what the revision draft
 * keeps. What is credited in the end also goes through `creditTime`.
 */
export function revisionSeconds(input: {
  /** what the browser says, or what was saved with the draft */
  reported: number;
  reviewedAt: Date;
  now: Date;
  /** the project's time limit, in seconds */
  limitSeconds: number;
  /** active seconds the assignment has been credited so far */
  credited: number;
}): number {
  const passed = clampActiveSeconds(input.reported, input.reviewedAt, input.now);
  return Math.min(passed, revisionCap(input.limitSeconds, input.credited));
}

export type Interval = { start: Date; end: Date };

/**
 * How far back a credit may reach: the longest a claim can live (the
 * longest time limit and every extension, `MAX_CLAIM_MS`), so a claim is
 * never cut off. A revision has no deadline and is credited only within this
 * far back before it is handed in. Intervals that end before this far back
 * can never matter again and are removed.
 */
export const CREDIT_WINDOW_MS = MAX_CLAIM_MS;

/** The earliest moment a credit made at `now` can use, and before which stored intervals are dropped. */
export function creditHorizon(now: Date): Date {
  return new Date(now.getTime() - CREDIT_WINDOW_MS);
}

/** Intervals sorted by start, with overlapping and touching ones joined. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];
  for (const next of sorted) {
    const last = merged.at(-1);
    if (last && next.start <= last.end) {
      if (next.end > last.end) last.end = next.end;
    } else {
      merged.push(next);
    }
  }
  return merged;
}

export type Credit = {
  /** the seconds the work is credited */
  seconds: number;
  /** the stretches of time this credit takes, to be stored with the others */
  pieces: Interval[];
};

/**
 * Credits working time, for a first submission and for a revision alike.
 * This is the only place it happens.
 *
 * Wall-clock time is one resource per person. Three submissions that were
 * sent back at 09:30 and are all resubmitted at 09:50 hold twenty minutes of
 * work between them, not sixty, and a revision cannot be done in the same
 * minutes as a claim. So the stretches of a person's time that have been
 * credited are kept (`credited`), and a piece of work is credited from its
 * own window, from `start` (the claim, or the review that sent it back, and
 * not before `creditHorizon`) to now, minus what has been credited already:
 *
 *   - The free time of the window is taken from its earliest part on. Work
 *     that started later cannot use that part, so taking it first leaves the
 *     most for the work still open: a claim from 09:00 handed in at 09:30,
 *     after a revision of 09:10 to 09:15 was credited, still gets its 1500
 *     seconds.
 *   - What is credited is stored (`pieces`). No two credits overlap, so the
 *     sum can never be more than the time that has passed.
 *   - `cap` is a limit the work has of its own, as a revision does.
 */
export function creditTime(input: {
  /** what the browser says, or what was saved with the draft */
  reported: number;
  start: Date;
  now: Date;
  credited: readonly Interval[];
  cap?: number;
}): Credit {
  const { now } = input;
  const horizon = creditHorizon(now);
  const from = input.start > horizon ? input.start : horizon;
  if (now <= from) return { seconds: 0, pieces: [] };
  // the free stretches of the window, earliest first
  const free: Interval[] = [];
  let cursor = from;
  for (const taken of mergeIntervals(input.credited)) {
    if (taken.end <= cursor) continue;
    if (taken.start >= now) break;
    if (taken.start > cursor) free.push({ start: cursor, end: taken.start });
    if (taken.end > cursor) cursor = taken.end;
  }
  if (cursor < now) free.push({ start: cursor, end: now });
  const freeMs = free.reduce((sum, i) => sum + (i.end.getTime() - i.start.getTime()), 0);

  const cap = input.cap === undefined ? Infinity : Number.isFinite(input.cap) ? input.cap : 0;
  const seconds = Math.max(
    0,
    Math.min(
      clampActiveSeconds(input.reported, from, now),
      Math.floor(cap),
      Math.floor(freeMs / 1000),
    ),
  );
  const pieces: Interval[] = [];
  let left = seconds * 1000;
  for (const gap of free) {
    if (left <= 0) break;
    const length = Math.min(left, gap.end.getTime() - gap.start.getTime());
    pieces.push({ start: gap.start, end: new Date(gap.start.getTime() + length) });
    left -= length;
  }
  return { seconds, pieces };
}
