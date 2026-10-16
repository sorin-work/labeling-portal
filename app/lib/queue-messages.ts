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

export function queueMessage(code: string | null): string | null {
  return code ? (MESSAGES[code] ?? null) : null;
}
