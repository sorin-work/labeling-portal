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

/**
 * However often work is sent back, one assignment is never credited more than
 * this many of its project's time limits in total. A first submission is at
 * most two (the claim and its one extension), which leaves one for revising.
 */
export const MAX_CREDITED_LIMITS = 3;

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

export type Credit = {
  /** the seconds the work is credited */
  seconds: number;
  /** up to when the person's time is accounted for afterwards */
  creditedUntil: Date | null;
};

/**
 * Credits working time, for a first submission and for a revision alike.
 * This is the only place it happens.
 *
 * Wall-clock time is one resource per person. Three submissions that were
 * sent back at 09:30 and are all resubmitted at 09:50 hold twenty minutes of
 * work between them, not sixty, and a revision cannot be done in the same
 * minutes as a claim. So the person has a moment up to which their time has
 * been credited (`creditedUntil`, on their membership), and a piece of work
 * is credited from the later of that moment and its own start, up to now:
 *
 *   - `start` is when the work could begin: the claim, or the review that
 *     sent it back. Nothing before it counts for this work.
 *   - Crediting moves the moment forward by what was credited, from where
 *     the credit began. Every credit is therefore an interval of its own,
 *     inside the time the work was open, and no two overlap. The sum can
 *     never be more than the time that has passed.
 *   - `cap` is a limit the work has of its own, as a revision does.
 */
export function creditTime(input: {
  /** what the browser says, or what was saved with the draft */
  reported: number;
  start: Date;
  now: Date;
  creditedUntil: Date | null;
  cap?: number;
}): Credit {
  const { start, now, creditedUntil } = input;
  const from = creditedUntil !== null && creditedUntil > start ? creditedUntil : start;
  const cap = input.cap === undefined ? Infinity : Number.isFinite(input.cap) ? input.cap : 0;
  const seconds = Math.max(0, Math.min(clampActiveSeconds(input.reported, from, now), cap));
  if (seconds === 0) return { seconds, creditedUntil };
  return { seconds, creditedUntil: new Date(from.getTime() + seconds * 1000) };
}
