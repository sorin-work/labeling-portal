import { describe, expect, it } from 'vitest';

import {
  categoricalValue,
  cohensKappa,
  describeKappa,
  fleissKappa,
  pairwiseKappas,
} from '~/domain/agreement';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

describe('cohensKappa', () => {
  it('matches a textbook example', () => {
    // 50 items: both yes 20, both no 15, A yes/B no 5, A no/B yes 10
    const pairs: Array<[string, string]> = [
      ...Array(20).fill(['yes', 'yes']),
      ...Array(15).fill(['no', 'no']),
      ...Array(5).fill(['yes', 'no']),
      ...Array(10).fill(['no', 'yes']),
    ];
    expect(cohensKappa(pairs)).toBeCloseTo(0.4, 5);
  });

  it('is 1 for perfect agreement across labels', () => {
    expect(
      cohensKappa([
        ['a', 'a'],
        ['b', 'b'],
        ['c', 'c'],
      ]),
    ).toBe(1);
  });

  it('is 1, not NaN, when both raters always used the same label', () => {
    expect(
      cohensKappa([
        ['pos', 'pos'],
        ['pos', 'pos'],
        ['pos', 'pos'],
      ]),
    ).toBe(1);
  });

  it('can be negative', () => {
    expect(
      cohensKappa([
        ['a', 'b'],
        ['b', 'a'],
      ]),
    ).toBeLessThan(0);
  });

  it('returns null without data', () => {
    expect(cohensKappa([])).toBeNull();
  });
});

describe('fleissKappa', () => {
  it('matches the Wikipedia worked example', () => {
    // 10 subjects, 14 raters, 5 categories
    const table = [
      [0, 0, 0, 0, 14],
      [0, 2, 6, 4, 2],
      [0, 0, 3, 5, 6],
      [0, 3, 9, 2, 0],
      [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0],
      [3, 2, 6, 3, 0],
      [2, 5, 3, 2, 2],
      [6, 5, 2, 1, 0],
      [0, 2, 2, 3, 7],
    ];
    const items = table.map((row) => row.flatMap((count, cat) => Array(count).fill(`c${cat}`)));
    expect(fleissKappa(items)).toBeCloseTo(0.21, 2);
  });

  it('ignores items with a single rating', () => {
    expect(fleissKappa([['a'], ['b']])).toBeNull();
  });

  it('handles everyone always choosing the same label', () => {
    expect(
      fleissKappa([
        ['a', 'a'],
        ['a', 'a', 'a'],
      ]),
    ).toBe(1);
  });
});

describe('pairwiseKappas', () => {
  it('compares annotators on the items they share', () => {
    const ratings = new Map([
      [
        'ann',
        new Map([
          ['t1', 'x'],
          ['t2', 'y'],
          ['t3', 'x'],
          ['t4', 'y'],
        ]),
      ],
      [
        'ben',
        new Map([
          ['t1', 'x'],
          ['t2', 'y'],
          ['t3', 'x'],
          ['t9', 'x'],
        ]),
      ],
      ['cat', new Map([['t9', 'x']])],
    ]);
    const result = pairwiseKappas(ratings);
    expect(result).toEqual([{ a: 'ann', b: 'ben', shared: 3, kappa: 1 }]);
  });
});

describe('categoricalValue', () => {
  it('uses labels and preferences', () => {
    expect(categoricalValue(SCHEMA_TEMPLATES.text_classification, { labels: ['b', 'a'] })).toBe(
      'a|b',
    );
    expect(
      categoricalValue(SCHEMA_TEMPLATES.pairwise, {
        preference: 'B',
        scores: { a: {}, b: {} },
        rationale: '',
      }),
    ).toBe('B');
    expect(categoricalValue(SCHEMA_TEMPLATES.ner, { spans: [] })).toBeNull();
  });
});

describe('describeKappa', () => {
  it('uses the usual bands', () => {
    expect(describeKappa(0.1)).toBe('slight');
    expect(describeKappa(0.65)).toBe('substantial');
    expect(describeKappa(0.95)).toBe('almost perfect');
    expect(describeKappa(null)).toBe('not enough data');
  });
});
