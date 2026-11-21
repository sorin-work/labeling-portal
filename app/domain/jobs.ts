/** How long a failed job waits before it is tried again: 30 s, 1 min, 2 min, ... up to an hour. */
export function retryDelayMs(attempts: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 60 * 60_000);
}

/** The first line of what a handler threw, short enough to keep on the job. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split('\n')[0] || 'failed').slice(0, 500);
}
