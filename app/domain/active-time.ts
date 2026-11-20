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
 * The seconds one revision of sent-back work is credited. A first submission
 * is bounded by its claim: after the time limit the claim is gone. Revising
 * has no claim and no deadline, so the same bound is applied here by hand.
 * Not more than the time since the review, not more than the project's time
 * limit for one revision, and not more than what is left of
 * MAX_CREDITED_LIMITS time limits for the assignment as a whole. Every
 * project has a time limit (1 to 480 minutes), so there is always a bound.
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
  // a limit or a total that is not a number bounds nothing, so it credits nothing
  const limit = Number.isFinite(input.limitSeconds)
    ? Math.max(0, Math.floor(input.limitSeconds))
    : 0;
  const passed = clampActiveSeconds(input.reported, input.reviewedAt, input.now);
  const left = Number.isFinite(input.credited)
    ? Math.max(0, MAX_CREDITED_LIMITS * limit - Math.ceil(input.credited))
    : 0;
  return Math.min(passed, limit, left);
}
