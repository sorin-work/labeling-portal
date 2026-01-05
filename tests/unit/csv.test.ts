import { describe, expect, it } from 'vitest';

import { parseCsv, parseCsvRecords, toCsv } from '~/domain/csv';

describe('parseCsv', () => {
  it('reads a header and rows', () => {
    const table = parseCsv('id,text\n1,hello\n2,world\n');
    expect(table.header).toEqual(['id', 'text']);
    expect(table.rows.map((r) => r.values)).toEqual([
      ['1', 'hello'],
      ['2', 'world'],
    ]);
  });

  it('handles quoted commas and line breaks', () => {
    const table = parseCsv('id,text\n1,"hello, there"\n2,"two\nlines"\n3,after\n');
    expect(table.rows.map((r) => r.values[1])).toEqual(['hello, there', 'two\nlines', 'after']);
  });

  it('tracks the line each record starts on', () => {
    const records = parseCsvRecords('a\n"multi\nline"\nb\n');
    expect(records.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it('accepts CRLF line endings and a byte order mark', () => {
    const table = parseCsv('﻿id,text\r\n1,x\r\n');
    expect(table.header).toEqual(['id', 'text']);
    expect(table.rows[0].values).toEqual(['1', 'x']);
  });

  it('skips blank lines', () => {
    expect(parseCsv('id\n\n1\n\n').rows.map((r) => r.values)).toEqual([['1']]);
  });

  it('keeps empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,\n').rows[0].values).toEqual(['1', '', '']);
  });

  it('returns an empty table for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });
});

describe('toCsv', () => {
  it('quotes fields that need it', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['plain', 'with, comma'],
          ['say "hi"', null],
        ],
      ),
    ).toBe('a,b\r\nplain,"with, comma"\r\n"say ""hi""",\r\n');
  });

  it('writes numbers as text', () => {
    expect(toCsv(['n'], [[1.5]])).toBe('n\r\n1.5\r\n');
  });
});
