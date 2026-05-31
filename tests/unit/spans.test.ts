import { describe, expect, it } from 'vitest';

import { addSpan, removeSpan, segmentText, spanText, trimSelection } from '~/domain/spans';

const text = 'Grace Hopper joined the Navy in 1943.';

describe('spanText', () => {
  it('returns the covered text', () => {
    expect(spanText(text, { start: 0, end: 12 })).toBe('Grace Hopper');
    expect(spanText(text, { start: 24, end: 28 })).toBe('Navy');
  });
});

describe('spanText with characters outside the basic plane', () => {
  it('uses the same offsets as the browser', () => {
    const party = '\u{1F389} Ada wrote code';
    const start = party.indexOf('Ada');
    expect(spanText(party, { start, end: start + 3 })).toBe('Ada');
  });
});

describe('trimSelection', () => {
  it('drops surrounding whitespace and orders the ends', () => {
    expect(trimSelection(text, 13, 5)).toEqual([6, 12]);
    expect(trimSelection('  hi  ', 0, 6)).toEqual([2, 4]);
  });

  it('collapses a whitespace-only selection', () => {
    const [s, e] = trimSelection('a   b', 1, 4);
    expect(s).toBe(e);
  });
});

describe('addSpan', () => {
  it('replaces overlapping spans and keeps order', () => {
    const spans = [
      { start: 24, end: 28, label: 'ORG' },
      { start: 0, end: 5, label: 'PERSON' },
    ];
    expect(addSpan(spans, { start: 0, end: 12, label: 'PERSON' })).toEqual([
      { start: 0, end: 12, label: 'PERSON' },
      { start: 24, end: 28, label: 'ORG' },
    ]);
  });

  it('keeps touching spans', () => {
    const result = addSpan([{ start: 0, end: 5, label: 'A' }], { start: 5, end: 8, label: 'B' });
    expect(result).toHaveLength(2);
  });
});

describe('removeSpan', () => {
  it('removes by position', () => {
    expect(removeSpan([{ start: 0, end: 5, label: 'A' }], { start: 0, end: 5 })).toEqual([]);
  });
});

describe('segmentText', () => {
  it('splits text around spans', () => {
    const segments = segmentText(text, [{ start: 24, end: 28, label: 'ORG' }]);
    expect(segments.map((s) => [s.text, s.span?.label ?? null])).toEqual([
      ['Grace Hopper joined the ', null],
      ['Navy', 'ORG'],
      [' in 1943.', null],
    ]);
  });

  it('ignores spans that overlap or run past the end', () => {
    const segments = segmentText('abcdef', [
      { start: 0, end: 3, label: 'A' },
      { start: 2, end: 4, label: 'B' },
      { start: 4, end: 99, label: 'C' },
    ]);
    expect(segments.map((s) => s.text)).toEqual(['abc', 'def']);
  });

  it('returns the whole text when there are no spans', () => {
    expect(segmentText('plain', [])).toEqual([{ text: 'plain', start: 0, end: 5, span: null }]);
  });
});
