import type { QueueOrder } from '@prisma/client';

export const QUEUE_ORDERS: Record<QueueOrder, string> = {
  IMPORT: 'Import order',
  SHUFFLED: 'Shuffled, differently for every annotator',
};

export const MIN_GOLD_EVERY = 2;
export const MAX_GOLD_EVERY = 500;

/**
 * After this many minutes without a submission in the project, the next task
 * an annotator gets counts as the first of a new session. Gold spacing never
 * makes that one a gold task.
 */
export const SESSION_GAP_MINUTES = 30;

/**
 * With "about one gold task in every N", the number of regular tasks between
 * two gold tasks is drawn anew each time from this range, N on average. A
 * fixed N would make gold tasks easy to count out.
 */
export function goldGapRange(goldEvery: number): { lo: number; hi: number } {
  const spread = Math.floor(goldEvery / 2);
  return { lo: Math.max(1, goldEvery - spread), hi: goldEvery + spread };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Reads the gold spacing field of the project form. Empty means no spacing. */
export function parseGoldEvery(raw: unknown): Parsed<number | null> {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isInteger(value) || value < MIN_GOLD_EVERY || value > MAX_GOLD_EVERY) {
    return {
      ok: false,
      error: `Gold spacing must be a whole number from ${MIN_GOLD_EVERY} to ${MAX_GOLD_EVERY}, or empty`,
    };
  }
  return { ok: true, value };
}

/** Reads the task order field of the project form. A form without it keeps import order. */
export function parseQueueOrder(raw: unknown): Parsed<QueueOrder> {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: 'IMPORT' };
  if (raw === 'IMPORT' || raw === 'SHUFFLED') return { ok: true, value: raw };
  return { ok: false, error: 'Choose import order or shuffled' };
}

export const MAX_BATCH_PRIORITY = 100;

/** Reads a batch priority: a whole number, higher is handed out first, 0 is normal. */
export function parseBatchPriority(raw: unknown): Parsed<number> {
  const text = String(raw ?? '').trim();
  const value = Number(text);
  if (text === '' || !Number.isInteger(value) || Math.abs(value) > MAX_BATCH_PRIORITY) {
    return {
      ok: false,
      error: `Priority must be a whole number from -${MAX_BATCH_PRIORITY} to ${MAX_BATCH_PRIORITY}`,
    };
  }
  return { ok: true, value };
}
