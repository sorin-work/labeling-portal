import { describe, expect, it } from 'vitest';

import {
  cursorRange,
  moveCursor,
  splitAtRange,
  wordAt,
  wordRanges,
  addSpan,
  relabelSpan,
  removeSpan,
  segmentText,
  spanText,
  trimSelection,
} from '~/domain/spans';

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

describe('relabelSpan', () => {
  it('changes the type of one span and keeps its boundaries', () => {
    const spans = [
      { start: 0, end: 12, label: 'PERSON' },
      { start: 24, end: 28, label: 'PERSON' },
    ];
    expect(relabelSpan(spans, { start: 24, end: 28 }, 'ORG')).toEqual([
      { start: 0, end: 12, label: 'PERSON' },
      { start: 24, end: 28, label: 'ORG' },
    ]);
    expect(relabelSpan(spans, { start: 1, end: 2 }, 'ORG')).toEqual(spans);
  });
});

describe('the keyboard cursor', () => {
  const text = "Ada Lovelace was born in London, in 1815. O'Brien's well-known.";
  const words = wordRanges(text);
  const said = (r: { start: number; end: number } | null) =>
    r ? text.slice(r.start, r.end) : null;

  it('steps over words and single punctuation marks', () => {
    expect(words.map((w) => said(w))).toEqual([
      'Ada',
      'Lovelace',
      'was',
      'born',
      'in',
      'London',
      ',',
      'in',
      '1815',
      '.',
      "O'Brien's",
      'well-known',
      '.',
    ]);
    expect(wordRanges('  ')).toEqual([]);
  });

  it('moves word by word and stops at both ends', () => {
    let cursor = { anchor: 0, focus: 0 };
    cursor = moveCursor(words, cursor, -1, false);
    expect(cursor).toEqual({ anchor: 0, focus: 0 });
    cursor = moveCursor(words, cursor, 1, false);
    expect(said(cursorRange(words, cursor))).toBe('Lovelace');
    cursor = moveCursor(words, { anchor: 12, focus: 12 }, 1, false);
    expect(cursor).toEqual({ anchor: 12, focus: 12 });
  });

  it('extends with Shift in either direction, and shrinks back', () => {
    let cursor = moveCursor(words, { anchor: 0, focus: 0 }, 1, true);
    expect(said(cursorRange(words, cursor))).toBe('Ada Lovelace');
    cursor = moveCursor(words, { anchor: 5, focus: 5 }, -2, true);
    expect(said(cursorRange(words, cursor))).toBe('born in London');
    cursor = moveCursor(words, cursor, 1, true);
    expect(said(cursorRange(words, cursor))).toBe('in London');
    // a plain arrow collapses the selection onto the moving end
    expect(moveCursor(words, cursor, 0, false)).toEqual({ anchor: 4, focus: 4 });
  });

  it('starts on the word that holds an offset', () => {
    expect(wordAt(words, 0)).toBe(0);
    expect(wordAt(words, 3)).toBe(1); // the space after "Ada": the next word
    expect(wordAt(words, text.length)).toBe(words.length - 1);
    expect(wordAt([], 4)).toBe(0);
    expect(cursorRange([], { anchor: 0, focus: 0 })).toBeNull();
  });

  it('cuts the text pieces at the cursor so it can be drawn', () => {
    const spans = [{ start: 0, end: 12, label: 'PERSON' }];
    const range = cursorRange(words, { anchor: 3, focus: 5 })!;
    const pieces = splitAtRange(segmentText(text, spans), range);
    expect(pieces.map((p) => [p.text, p.inRange])).toEqual([
      ['Ada Lovelace', false],
      [' was ', false],
      ['born in London', true],
      [text.slice(range.end), false],
    ]);
    // a span the cursor touches is drawn as selected, and never cut
    const over = splitAtRange(segmentText(text, spans), { start: 4, end: 16 });
    expect(over.map((p) => [p.text, p.inRange])).toEqual([
      ['Ada Lovelace', true],
      [' was', true],
      [text.slice(16), false],
    ]);
  });
});
