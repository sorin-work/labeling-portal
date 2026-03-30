const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a YYYY-MM-DD string, returning null for anything else. */
export function parseDay(value: string | null | undefined): string | null {
  if (!value || !DAY.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First and last day of the month containing `now`, in UTC. */
export function currentMonth(now = new Date()): { from: string; to: string } {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: toDay(first), to: toDay(last) };
}

/** A from/to day range from ?from=&to=, defaulting to the current month. */
export function readRange(url: URL, now = new Date()): { from: string; to: string } {
  const fallback = currentMonth(now);
  const from = parseDay(url.searchParams.get('from')) ?? fallback.from;
  const to = parseDay(url.searchParams.get('to')) ?? fallback.to;
  return from <= to ? { from, to } : { from: to, to: from };
}
