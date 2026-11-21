import { limitReachedMessage } from '~/domain/daily-limit';

/**
 * Messages for the ?queue= parameter the work routes redirect to when there
 * is no task to show.
 */
const MESSAGES: Record<string, string> = {
  empty: 'There are no more tasks for you in this project right now.',
  inactive: 'This project is not taking work at the moment.',
  expired: 'Your time on that task ran out, so it went back to the queue.',
  qualified: 'You passed the qualification test. Welcome aboard!',
};

/**
 * The message for a code. `limit` says when the next UTC day starts, so it
 * needs the project's limit and the time.
 */
export function queueMessage(
  code: string | null,
  context: { dailyTaskLimit: number | null; now: Date },
): string | null {
  if (code === 'limit') return limitReachedMessage(context.dailyTaskLimit, context.now);
  return code ? (MESSAGES[code] ?? null) : null;
}
