import { describe, expect, it } from 'vitest';

import {
  guardFormula,
  parseCsv,
  parseCsvRecords,
  sniffDelimiter,
  toCsv,
  toCsvLine,
  unguardFormula,
} from '~/domain/csv';

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

  it('keeps doubled quotes inside quoted fields', () => {
    const table = parseCsv('id,text\n1,"She said ""great"", then left"\n2,""""\n');
    expect(table.rows.map((r) => r.values[1])).toEqual(['She said "great", then left', '"']);
  });

  it('reads back what toCsv writes', () => {
    const rows = [
      ['a "quoted" word', 'comma, here'],
      ['line\nbreak', '""'],
    ];
    const table = parseCsv(toCsv(['x', 'y'], rows));
    expect(table.rows.map((r) => r.values)).toEqual(rows);
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

  it('takes a quote in the middle of a field as an ordinary character', () => {
    const table = parseCsv('id,text\n1,5" disk and 3" tape\n2,say "hi", twice\n3,"quoted" tail\n');
    expect(table.rows.map((r) => r.values)).toEqual([
      ['1', '5" disk and 3" tape'],
      ['2', 'say "hi"', ' twice'],
      ['3', 'quoted tail'],
    ]);
  });

  it('returns an empty table for empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [], openQuoteLine: null });
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

describe('other delimiters', () => {
  it('reads tab-separated text, with commas and semicolons as ordinary characters', () => {
    const table = parseCsv('id\ttext\n1\tone, two; three\n2\t"tab\tinside"\n', '\t');
    expect(table.header).toEqual(['id', 'text']);
    expect(table.rows.map((r) => r.values)).toEqual([
      ['1', 'one, two; three'],
      ['2', 'tab\tinside'],
    ]);
  });

  it('reads semicolon-separated text', () => {
    const table = parseCsv('id;price\n1;12,50\n2;"a;b"\n', ';');
    expect(table.rows.map((r) => r.values)).toEqual([
      ['1', '12,50'],
      ['2', 'a;b'],
    ]);
  });

  it('tells semicolon files from comma files by the header line', () => {
    expect(sniffDelimiter('id,text,source\n1;2;3;4;5\n')).toBe(',');
    expect(sniffDelimiter('id;text;source\n1,2,3,4,5\n')).toBe(';');
    // the delimiter inside a quoted header does not count
    expect(sniffDelimiter('"a;b;c",d\n')).toBe(',');
    expect(sniffDelimiter('"a,b,c";d\n')).toBe(';');
    // one column, an empty file, and a tie all go to the comma
    expect(sniffDelimiter('text\n')).toBe(',');
    expect(sniffDelimiter('')).toBe(',');
    expect(sniffDelimiter('a,b;c\n')).toBe(',');
    expect(sniffDelimiter('\uFEFFid;text\n')).toBe(';');
  });
});

describe('cells a spreadsheet would run as a formula', () => {
  it('get a quote in front when they start with = + - @, a tab or a carriage return', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(guardFormula(`${start}cmd`)).toBe(`'${start}cmd`);
    }
    expect(guardFormula('=HYPERLINK("http://x.test","click")')).toBe(
      `'=HYPERLINK("http://x.test","click")`,
    );
    // nothing else is touched, also not a formula sign further in
    for (const text of ['plain', 'a=b', ' =1+1', "'quoted", '', '1-2']) {
      expect(guardFormula(text)).toBe(text);
    }
    // text that starts with a quote and then a formula sign gets one more quote
    expect(guardFormula("'=1+1")).toBe("''=1+1");
  });

  it('are guarded in every line that is written, unless the file is kept as it is', () => {
    expect(toCsvLine(['=1+1', '@you', '-3', 'ok'])).toBe("'=1+1,'@you,'-3,ok\r\n");
    // a guarded cell that also needs quotes gets both
    expect(toCsvLine(['=SUM(A1,B1)'])).toBe('"\'=SUM(A1,B1)"\r\n');
    expect(toCsv(['a'], [['=1']])).toBe("a\r\n'=1\r\n");
    expect(toCsv(['a'], [['=1']], 'keep')).toBe('a\r\n=1\r\n');
  });

  it('are left alone when they are numbers', () => {
    expect(toCsvLine([-3, 0.5, null, undefined])).toBe('-3,0.5,,\r\n');
  });

  it('come back as they were when the guard is taken off', () => {
    for (const text of ['=1+1', '+x', '-12', '@a', "'plain", "'=quoted", "''=two", 'ok', '']) {
      expect(unguardFormula(guardFormula(text))).toBe(text);
    }
    // a quote in front of ordinary text is not a guard
    expect(unguardFormula("'plain")).toBe("'plain");
  });
});

describe('a quote that is never closed', () => {
  it('says where it opened', () => {
    expect(parseCsv('text\na\n"b\nc\n').openQuoteLine).toBe(3);
    expect(parseCsv('id,text\n1,"x\n2,y\n').openQuoteLine).toBe(2);
    expect(parseCsv('id,text\n1,"x\ny"\n2,z\n').openQuoteLine).toBeNull();
    // a quote in the middle of a field opens nothing
    expect(parseCsv('id,text\n1,5" disk\n').openQuoteLine).toBeNull();
  });
});
