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
 * makes that one a gold task. The task after it is a draw like any other.
 */
export const SESSION_GAP_MINUTES = 30;

/**
 * "About one gold task in every N" as a draw without memory: each claim is a
 * gold task with a chance of 1 in N, whatever came before. A schedule with a
 * shortest and a longest gap would tell an annotator that the tasks right
 * after a gold task are regular, and that one is certain after the longest
 * gap. The draw comes from a hash keyed with the project's secret, so it is
 * the same on a reload and cannot be worked out from anything an annotator
 * sees.
 *
 * The cap keeps a lucky streak from running away: when `max` of the last
 * `window` submissions were gold already, the next claim is regular. With
 * twice the expected number it is rarely reached.
 */
export function goldDraw(goldEvery: number): {
  /** a claim is gold when its 32-bit hash is below this */
  below: number;
  window: number;
  max: number;
} {
  const window = 5 * goldEvery;
  return { below: Math.floor(2 ** 32 / goldEvery), window, max: Math.min(10, window - 1) };
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
