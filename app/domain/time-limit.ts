/**
 * The time limit on a claim, as the annotator hears about it.
 *
 * More time can be asked for up to `MAX_EXTENSIONS` times per claim, each
 * time from the warning in the last two minutes, and each adds the project's
 * full time limit. Three keeps one person from holding a task for ever while
 * leaving room for those who need longer.
 */
export const MAX_EXTENSIONS = 3;

export function extensionsLeft(used: number): number {
  return Math.max(0, MAX_EXTENSIONS - used);
}

/**
 * Moments at which the time left is said aloud (a polite live region), in
 * minutes. Two minutes is left out: the warning with the "more time" button
 * appears then, and it is an alert of its own.
 */
export const ANNOUNCE_AT_MINUTES = [10, 5, 1];

/**
 * What to say when the time left goes from `before` to `now` milliseconds, or
 * null. One tick can cross a moment; a page that opens with less time left
 * than a moment says nothing about it.
 */
export function timeAnnouncement(before: number, now: number): string | null {
  if (before > 0 && now <= 0) return 'Time is up. The task goes back to the queue.';
  const crossed = ANNOUNCE_AT_MINUTES.filter((m) => before > m * 60_000 && now <= m * 60_000);
  if (crossed.length === 0) return null;
  const minutes = Math.min(...crossed);
  return minutes === 1 ? 'One minute left on this task.' : `${minutes} minutes left on this task.`;
}
