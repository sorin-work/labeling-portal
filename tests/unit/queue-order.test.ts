import { describe, expect, it } from 'vitest';

import {
  goldDraw,
  MAX_BATCH_PRIORITY,
  parseBatchPriority,
  parseGoldEvery,
  parseQueueOrder,
} from '~/domain/queue-order';

describe('gold draw', () => {
  it('gives each claim a chance of one in N', () => {
    for (const n of [2, 3, 10, 500]) {
      expect(goldDraw(n).below / 2 ** 32).toBeCloseTo(1 / n, 6);
    }
  });

  it('caps gold at twice the expected number over a window of 5N, below all of it', () => {
    expect(goldDraw(10)).toMatchObject({ window: 50, max: 10 });
    expect(goldDraw(2)).toMatchObject({ window: 10, max: 9 });
  });
});

describe('queue settings', () => {
  it('reads gold spacing, empty meaning off', () => {
    expect(parseGoldEvery('')).toEqual({ ok: true, value: null });
    expect(parseGoldEvery(null)).toEqual({ ok: true, value: null });
    expect(parseGoldEvery(' 12 ')).toEqual({ ok: true, value: 12 });
    for (const bad of ['1', '0', '-3', '2.5', 'ten', '501']) {
      expect(parseGoldEvery(bad).ok).toBe(false);
    }
  });

  it('reads the task order, keeping import order when the field is missing', () => {
    expect(parseQueueOrder(null)).toEqual({ ok: true, value: 'IMPORT' });
    expect(parseQueueOrder('SHUFFLED')).toEqual({ ok: true, value: 'SHUFFLED' });
    expect(parseQueueOrder('RANDOM').ok).toBe(false);
  });

  it('reads a batch priority inside its bounds', () => {
    expect(parseBatchPriority('0')).toEqual({ ok: true, value: 0 });
    expect(parseBatchPriority('-4')).toEqual({ ok: true, value: -4 });
    expect(parseBatchPriority(String(MAX_BATCH_PRIORITY))).toEqual({
      ok: true,
      value: MAX_BATCH_PRIORITY,
    });
    for (const bad of ['', '1.5', 'high', String(MAX_BATCH_PRIORITY + 1)]) {
      expect(parseBatchPriority(bad).ok).toBe(false);
    }
  });
});
