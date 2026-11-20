import { describe, expect, it } from 'vitest';

import {
  goldGapRange,
  MAX_BATCH_PRIORITY,
  parseBatchPriority,
  parseGoldEvery,
  parseQueueOrder,
} from '~/domain/queue-order';

describe('gold spacing range', () => {
  it('averages N and is never a fixed period', () => {
    for (const n of [2, 3, 5, 10, 25, 500]) {
      const { lo, hi } = goldGapRange(n);
      expect((lo + hi) / 2).toBeCloseTo(n, 0);
      expect(hi).toBeGreaterThan(lo);
      expect(lo).toBeGreaterThanOrEqual(1);
    }
  });

  it('spreads by half of N on each side', () => {
    expect(goldGapRange(10)).toEqual({ lo: 5, hi: 15 });
    expect(goldGapRange(2)).toEqual({ lo: 1, hi: 3 });
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
