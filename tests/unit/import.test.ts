import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  detectFormat,
  isImageRef,
  isInternalHost,
  MAX_IMPORT_BYTES,
  MAX_JSON_DEPTH,
  MAX_IMPORT_ROWS,
  MAX_REPORTED_ERRORS,
  parseImport,
  readImportFile,
} from '~/domain/import';
import { SCHEMA_TEMPLATES, type TaskSchema } from '~/domain/task-schema';
import { ZipWriter } from '~/domain/zip';

const classification = SCHEMA_TEMPLATES.text_classification;

describe('detectFormat', () => {
  it('uses the file extension first', () => {
    expect(detectFormat('tasks.jsonl', 'id,text')).toBe('JSONL');
    expect(detectFormat('tasks.CSV', '{"a":1}')).toBe('CSV');
  });

  it('sniffs the content otherwise', () => {
    expect(detectFormat('upload', '  {"text":"x"}')).toBe('JSONL');
    expect(detectFormat('upload', 'text\nx')).toBe('CSV');
  });
});

describe('parseImport', () => {
  it('reads csv rows and the id column', () => {
    const result = parseImport('id,text\nr1,great product\nr2,awful\n', 'CSV', classification);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { line: 2, externalId: 'r1', data: { id: 'r1', text: 'great product' } },
      { line: 3, externalId: 'r2', data: { id: 'r2', text: 'awful' } },
    ]);
  });

  it('reads jsonl and keeps nested values', () => {
    const text = '{"text":"a","meta":{"source":"web"}}\n\n{"_id":"x","text":"b"}\n';
    const result = parseImport(text, 'JSONL', classification);
    expect(result.errors).toEqual([]);
    expect(result.rows[0].data).toEqual({ text: 'a', meta: { source: 'web' } });
    expect(result.rows[1]).toMatchObject({ line: 3, externalId: 'x', data: { text: 'b' } });
  });

  it('reports rows missing required fields', () => {
    const result = parseImport('id,text\n1,\n2,ok\n', 'CSV', classification);
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toEqual([{ line: 2, message: 'Missing text' }]);
  });

  it('reports bad json lines', () => {
    const result = parseImport('{"text":"a"}\nnot json\n[1,2]\n', 'JSONL', classification);
    expect(result.errors).toEqual([
      { line: 2, message: 'Not valid JSON' },
      { line: 3, message: 'Each line must be a JSON object' },
    ]);
  });

  it('flags duplicate ids', () => {
    const result = parseImport('id,text\n1,a\n1,b\n', 'CSV', classification);
    expect(result.errors[0].message).toBe('Duplicate id 1 (first on line 2)');
  });

  it('flags ragged csv rows', () => {
    const result = parseImport('id,text\n1,a,extra\n', 'CSV', classification);
    expect(result.errors[0]).toEqual({ line: 2, message: 'Expected 2 columns but found 3' });
  });

  it('checks every pairwise field', () => {
    const result = parseImport(
      '{"prompt":"p","response_a":"a"}',
      'JSONL',
      SCHEMA_TEMPLATES.pairwise,
    );
    expect(result.errors[0].message).toBe('Missing response_b');
  });

  it('requires image urls for bounding boxes', () => {
    const text = '{"image_url":"https://img.test/1.jpg"}\n{"image_url":"file.jpg"}\n';
    const result = parseImport(text, 'JSONL', SCHEMA_TEMPLATES.bbox);
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
  });

  it('complains about an empty file', () => {
    expect(parseImport('', 'CSV', classification).errors[0].message).toBe('The file has no tasks');
  });
});

describe('gold answers', () => {
  it('reads short gold labels from a csv column', () => {
    const result = parseImport('id,text,_gold\n1,great,positive\n2,meh,\n', 'CSV', classification);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toEqual({
      line: 2,
      externalId: '1',
      data: { id: '1', text: 'great' },
      gold: { labels: ['positive'] },
    });
    expect(result.rows[1].gold).toBeUndefined();
  });

  it('rejects gold labels that are not in the schema', () => {
    const result = parseImport('text,_gold\nx,amazing\n', 'CSV', classification);
    expect(result.errors).toEqual([{ line: 2, message: 'Gold answer: Unknown label: amazing' }]);
  });

  it('reads pairwise gold preferences and entity spans from jsonl', () => {
    const pairs = parseImport(
      '{"prompt":"p","response_a":"a","response_b":"b","_gold":"B"}',
      'JSONL',
      SCHEMA_TEMPLATES.pairwise,
    );
    expect(pairs.rows[0].gold).toEqual({
      preference: 'B',
      scores: { a: {}, b: {} },
      rationale: '',
    });

    const ner = parseImport(
      '{"text":"Ada wrote","_gold":{"spans":[{"start":0,"end":3,"label":"PERSON"}]}}',
      'JSONL',
      SCHEMA_TEMPLATES.ner,
    );
    expect(ner.rows[0].gold).toEqual({ spans: [{ start: 0, end: 3, label: 'PERSON' }] });
  });

  it('takes image size for gold boxes from the row', () => {
    const result = parseImport(
      '{"image_url":"/a.png","width":100,"height":80,"_gold":{"boxes":[{"x":1,"y":1,"w":10,"h":10,"label":"car"}]}}',
      'JSONL',
      SCHEMA_TEMPLATES.bbox,
    );
    expect(result.rows[0].gold).toMatchObject({ imageWidth: 100, imageHeight: 80 });
  });
});

describe('import edge cases', () => {
  it('handles jsonl with windows line endings and a byte order mark', () => {
    const result = parseImport('﻿{"text":"a"}\r\n{"text":"b"}\r\n', 'JSONL', classification);
    expect(result.errors).toEqual([]);
    expect(result.rows.map((r) => r.data.text)).toEqual(['a', 'b']);
  });

  it('keeps numbers and booleans from jsonl as they are', () => {
    const result = parseImport('{"text":"x","stars":4,"verified":true}', 'JSONL', classification);
    expect(result.rows[0].data).toEqual({ text: 'x', stars: 4, verified: true });
  });

  it('treats whitespace-only text as missing', () => {
    const result = parseImport('text\n"   "\n', 'CSV', classification);
    expect(result.errors).toEqual([{ line: 2, message: 'Missing text' }]);
  });

  it('trims header names', () => {
    const result = parseImport(' id , text \n1,hello\n', 'CSV', classification);
    expect(result.rows[0]).toMatchObject({ externalId: '1', data: { text: 'hello' } });
  });

  it('refuses files with more rows than a batch can hold', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `{"text":"${i}"}`).join('\n');
    const result = parseImport(rows, 'JSONL', classification);
    expect(result.rows).toEqual([]);
    expect(result.errors[0].message).toMatch(/at most 5000/);
  });
});

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'import', name)));
const read = (name: string, schema: TaskSchema = sentiment, options = {}) =>
  readImportFile(fixture(name), name, schema, options);
const sentiment = SCHEMA_TEMPLATES.text_classification;
const bytes = (text: string) => new TextEncoder().encode(text);

describe('sample files', () => {
  it('reads a comma csv with quotes and a line break in a cell', () => {
    const result = read('reviews.csv');
    expect(result).toMatchObject({ ok: true, format: 'CSV' });
    if (!result.ok) return;
    expect(result.rows.map((r) => [r.line, r.externalId, r.data.text])).toEqual([
      [2, 'r1', 'Great value, would buy again'],
      [3, 'r2', 'The "premium" model broke after a week'],
      [4, 'r3', 'Two lines\nin one cell'],
    ]);
    expect(result.rows[0].data).toEqual({
      id: 'r1',
      text: 'Great value, would buy again',
      source: 'web',
    });
  });

  it('reads a semicolon csv as spreadsheet programs write it in many locales', () => {
    const result = read('reviews-semicolon.csv');
    expect(result).toMatchObject({ ok: true, format: 'CSV' });
    if (!result.ok) return;
    expect(result.rows.map((r) => r.data)).toEqual([
      { id: 'r1', text: 'Great value, would buy again', price: '12,50' },
      { id: 'r2', text: 'Semicolons; inside quotes', price: '3,99' },
      { id: 'r3', text: 'Plain text', price: '0,10' },
    ]);
  });

  it('reads a tab-separated file', () => {
    const result = read('reviews.tsv');
    expect(result).toMatchObject({ ok: true, format: 'TSV' });
    if (!result.ok) return;
    expect(result.rows.map((r) => r.data.text)).toEqual([
      'Great value, would buy again',
      'The "premium" model broke; twice',
      'Tab\tinside quotes',
    ]);
  });

  it('reads json lines, skipping empty lines and keeping nested values', () => {
    const result = read('reviews.jsonl');
    expect(result).toMatchObject({ ok: true, format: 'JSONL' });
    if (!result.ok) return;
    expect(result.rows.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(result.rows[1].data).toEqual({
      id: 'r2',
      text: 'The "premium" model broke after a week',
      meta: { stars: 1, verified: true },
    });
  });

  it('reads a json array, which a .json file used to be refused for', () => {
    const result = read('reviews.json');
    expect(result).toMatchObject({ ok: true, format: 'JSON' });
    if (!result.ok) return;
    // the same tasks as the json lines file, counted as items
    const lines = read('reviews.jsonl');
    expect(result.rows.map((r) => r.data)).toEqual(lines.ok && lines.rows.map((r) => r.data));
    expect(result.rows.map((r) => r.line)).toEqual([1, 2, 3]);
  });

  it('reads a file with a byte order mark, windows line endings and accents', () => {
    const result = read('reviews-bom.csv');
    expect(result.ok && result.rows.map((r) => r.data)).toEqual([
      { id: 'r1', text: 'Café was fine' },
      { id: 'r2', text: 'Naïve but ok' },
    ]);
  });

  it('takes gold answers through the checks an answer gets', () => {
    const result = read('gold.csv');
    expect(result.ok && result.rows.map((r) => [r.externalId, r.gold])).toEqual([
      ['g1', { labels: ['positive'] }],
      ['g2', { labels: ['neutral'] }],
      ['t1', undefined],
    ]);
    // a schema without one of those labels refuses the file
    const narrower = { ...sentiment, labels: ['positive', 'negative'] };
    expect(read('gold.csv', narrower)).toMatchObject({
      ok: false,
      errors: [{ line: 3, message: 'Gold answer: Unknown label: neutral' }],
    });
  });
});

describe('a file with problems', () => {
  it('is refused as a whole, with the lines that failed', () => {
    expect(read('problems.csv')).toEqual({
      ok: false,
      message: 'Nothing was imported: some rows have problems. Fix them and upload the file again.',
      errors: [
        { line: 3, message: 'Missing text' },
        { line: 5, message: 'Duplicate id dup (first on line 4)' },
        { line: 6, message: 'Expected 2 columns but found 3' },
      ],
      more: 0,
      unit: 'line',
      validRows: 2,
    });
  });

  it('counts items, not lines, in a json array', () => {
    expect(read('problems.json')).toMatchObject({
      ok: false,
      unit: 'item',
      errors: [
        { line: 2, message: 'Each item must be a JSON object' },
        { line: 3, message: 'Missing text' },
        { line: 4, message: 'Duplicate id a (first on item 1)' },
      ],
      validRows: 1,
    });
  });

  it('says what a json file holds when it is one value and not one per line', () => {
    expect(read('one-object.json')).toMatchObject({
      ok: false,
      errors: [{ line: 0, message: 'The file holds one JSON value, not one object per line' }],
    });
    expect(readImportFile(bytes('{"a": 1}'), 'x.json', sentiment)).toMatchObject({
      ok: false,
      errors: [{ line: 1, message: 'Missing text' }],
    });
    expect(readImportFile(bytes('{"a":'), 'x.json', sentiment)).toMatchObject({
      ok: false,
      errors: [{ line: 1, message: 'Not valid JSON' }],
    });
    expect(readImportFile(bytes('["a", {"text": "x"}'), 'x.json', sentiment)).toMatchObject({
      ok: false,
      errors: [{ line: 0, message: 'The file is not valid JSON' }],
    });
    expect(readImportFile(bytes('"just a string"'), 'x.json', sentiment).ok).toBe(false);
  });

  it('lists the first problems and counts the rest', () => {
    const lines = ['id,text'];
    for (let i = 1; i <= 40; i++) lines.push(i % 4 === 0 ? `ok${i},fine` : `bad${i},`);
    const result = readImportFile(bytes(lines.join('\n')), 'many.csv', sentiment);
    expect(result).toMatchObject({ ok: false, more: 10, validRows: 10, unit: 'line' });
    if (result.ok) return;
    expect(result.errors).toHaveLength(MAX_REPORTED_ERRORS);
    expect(result.errors[0]).toEqual({ line: 2, message: 'Missing text' });
    expect(result.errors.at(-1)).toEqual({ line: 27, message: 'Missing text' });
  });

  it('needs a gold answer on every row of a qualification test', () => {
    expect(read('gold.csv', sentiment, { qualification: true })).toMatchObject({
      ok: false,
      errors: [{ line: 4, message: 'Qualification questions need a _gold answer' }],
      validRows: 2,
    });
  });
});

describe('what is not read at all', () => {
  const refused = (data: Uint8Array, name = 'tasks.csv') => {
    const result = readImportFile(data, name, sentiment);
    return result.ok ? 'imported' : result.message;
  };

  it('refuses archives and compressed files without unpacking them', () => {
    const zip = new ZipWriter();
    const archive = Buffer.concat([zip.add('tasks.csv', 'text\nhello\n'), zip.finish()]);
    expect(refused(archive, 'tasks.zip')).toMatch(/Zip and gzip files are not read/);
    // the name does not help: it is the content that is looked at
    expect(refused(archive, 'tasks.csv')).toMatch(/Zip and gzip files are not read/);
    expect(refused(gzipSync('text\nhello\n'), 'tasks.csv.gz')).toMatch(/Zip and gzip/);
    expect(refused(gzipSync('text\nhello\n'), 'tasks.csv')).toMatch(/Zip and gzip/);
  });

  it('refuses text that is not UTF-8, and binary files', () => {
    expect(refused(new Uint8Array([0xff, 0xfe, 0x74, 0x00, 0x65, 0x00]))).toMatch(/UTF-16/);
    expect(refused(new Uint8Array([0xfe, 0xff, 0x00, 0x74]))).toMatch(/UTF-16/);
    // latin-1 "café": a lone 0xe9 is not UTF-8
    expect(refused(new Uint8Array([0x74, 0x65, 0x78, 0x74, 0x0a, 0x63, 0x61, 0x66, 0xe9]))).toMatch(
      /in UTF-8/,
    );
    expect(refused(bytes('text\nhel\u0000lo\n'))).toMatch(/does not look like/);
  });

  it('refuses an empty file, one over 5 MB and one with too many rows', () => {
    expect(refused(new Uint8Array())).toBe('The file is empty.');
    expect(refused(new Uint8Array(MAX_IMPORT_BYTES + 1).fill(0x61))).toBe(
      'Files can be at most 5 MB.',
    );
    const rows = ['text', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `row ${i}`)];
    expect(readImportFile(bytes(rows.join('\n')), 'big.csv', sentiment)).toMatchObject({
      ok: false,
      errors: [{ line: 0, message: 'A batch can hold at most 5000 tasks' }],
      validRows: 0,
    });
    const lines = Array.from({ length: MAX_IMPORT_ROWS + 50 }, (_, i) => `{"text":"row ${i}"}`);
    expect(readImportFile(bytes(lines.join('\n')), 'big.jsonl', sentiment)).toMatchObject({
      ok: false,
      errors: [{ line: 0, message: 'A batch can hold at most 5000 tasks' }],
    });
  });
});

describe('the format of a file', () => {
  it('goes by the name, and by the content for .json and unknown names', () => {
    const cases: Array<[string, string, string]> = [
      ['a.csv', '{"x":1}', 'CSV'],
      ['a.tsv', 'a,b', 'TSV'],
      ['a.tab', 'a,b', 'TSV'],
      ['a.jsonl', '[1]', 'JSONL'],
      ['a.ndjson', 'a,b', 'JSONL'],
      ['a.json', '  [ {"x":1} ]', 'JSON'],
      ['a.json', '﻿[{"x":1}]', 'JSON'],
      ['a.json', '{"x":1}\n{"x":2}', 'JSONL'],
      ['upload', '[{"x":1}]', 'JSON'],
      ['upload', '{"x":1}', 'JSONL'],
      ['upload', 'a\tb\n1\t2', 'TSV'],
      ['upload', 'a,b\n1,2', 'CSV'],
      ['upload', 'a;b\n1;2', 'CSV'],
    ];
    for (const [name, text, format] of cases) {
      expect(detectFormat(name, text), `${name}: ${text}`).toBe(format);
    }
  });
});

describe('image addresses', () => {
  const boxes = SCHEMA_TEMPLATES.bbox;

  it('takes http and https addresses and paths on the portal', () => {
    const result = read('images.csv', boxes);
    expect(result.ok && result.rows.map((r) => r.data.image_url)).toEqual([
      'http://images.example.test/a.jpg',
      'https://images.example.test/b.jpg',
      '/demo/street-1.svg',
    ]);
  });

  it('refuses every other kind of address', () => {
    const result = read('images-refused.jsonl', boxes);
    expect(result).toMatchObject({ ok: false, validRows: 0 });
    if (result.ok) return;
    expect(result.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const error of result.errors) {
      expect(error.message).toBe(
        'image_url must be a public http(s) URL or a path starting with /',
      );
    }
    for (const address of [
      ' https://a.test/x.jpg',
      'https://a.test/x y.jpg',
      'HTTPS://a.test/x.jpg',
    ]) {
      expect(isImageRef(address), address).toBe(address === 'HTTPS://a.test/x.jpg');
    }
    expect(isImageRef(42)).toBe(false);
  });
});

describe('gold answers and the schema', () => {
  it('refuses a tie as a gold preference where the schema does not allow ties', () => {
    const row = '{"prompt":"p","response_a":"a","response_b":"b","_gold":"tie"}';
    const pairwise = SCHEMA_TEMPLATES.pairwise;
    expect(parseImport(row, 'JSONL', pairwise).rows[0].gold).toMatchObject({ preference: 'tie' });
    expect(parseImport(row, 'JSONL', { ...pairwise, allowTie: false }).errors).toEqual([
      { line: 1, message: 'Gold answer: Ties are not allowed here' },
    ]);
  });
});

describe('image addresses inside a network', () => {
  const boxes = SCHEMA_TEMPLATES.bbox;
  const internal = [
    'http://127.0.0.1/a.jpg',
    'http://127.1/a.jpg',
    'http://0x7f.1/a.jpg',
    'http://2130706433/a.jpg',
    'http://localhost/a.jpg',
    'http://LOCALHOST./a.jpg',
    'http://intranet/a.jpg',
    'http://printer.local/a.jpg',
    'http://app.localhost/a.jpg',
    'http://10.1.2.3/a.jpg',
    'http://172.16.0.1/a.jpg',
    'http://192.168.1.10/a.jpg',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/a.jpg',
    'http://0.0.0.0/a.jpg',
    'http://[::1]/a.jpg',
    'http://[::]/a.jpg',
    'http://[fe80::1]/a.jpg',
    'http://[fd00::1]/a.jpg',
    'http://[::ffff:127.0.0.1]/a.jpg',
    'http://[2002:7f00:1::]/a.jpg',
    'http://[2001:db8::1]/a.jpg',
  ];

  it('refuses loopback, private, link-local and reserved addresses and local names', () => {
    for (const address of internal) expect(isImageRef(address), address).toBe(false);
  });

  it('takes public addresses and names', () => {
    for (const address of [
      'https://cdn.example.test/a.jpg',
      'http://8.8.8.8/a.jpg',
      'http://172.32.0.1/a.jpg',
      'http://[2606:4700::1111]/a.jpg',
      'https://localhost.example.com/a.jpg',
    ]) {
      expect(isImageRef(address), address).toBe(true);
    }
    expect(isInternalHost('images.example.test')).toBe(false);
  });

  it('takes an internal host only when the installation lists it', () => {
    expect(isImageRef('http://images.internal:8080/a.jpg', ['images.internal'])).toBe(true);
    expect(isImageRef('http://10.0.0.5/a.jpg', ['10.0.0.5'])).toBe(true);
    expect(isImageRef('http://10.0.0.6/a.jpg', ['10.0.0.5'])).toBe(false);
    const row = '{"image_url":"http://10.0.0.5/a.jpg"}';
    expect(parseImport(row, 'JSONL', boxes).errors).toEqual([
      { line: 1, message: 'image_url must be a public http(s) URL or a path starting with /' },
    ]);
    expect(parseImport(row, 'JSONL', boxes, { internalImageHosts: ['10.0.0.5'] }).errors).toEqual(
      [],
    );
  });
});

describe('a quoted field that is never closed', () => {
  it('is refused on the line where it opened, with one column', () => {
    const result = parseImport('text\nfirst\n"second\nthird\nfourth\n', 'CSV', classification);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { line: 3, message: 'A quoted field starts here and is never closed' },
    ]);
  });

  it('is refused on the line where it opened, with two columns', () => {
    const result = parseImport('id,text\n1,one\n2,"two\n3,three\n', 'CSV', classification);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([
      { line: 3, message: 'A quoted field starts here and is never closed' },
    ]);
  });
});

describe('values nested too deep', () => {
  const deep = (levels: number) => '['.repeat(levels) + ']'.repeat(levels);

  it('are refused with their line in json lines and json arrays', () => {
    const lines = `{"text":"fine"}\n{"text":"x","extra":${deep(200_000)}}\n`;
    expect(parseImport(lines, 'JSONL', classification).errors).toEqual([
      { line: 2, message: `Nested more than ${MAX_JSON_DEPTH} levels deep` },
    ]);
    const array = `[{"text":"fine"},{"text":"x","extra":${deep(MAX_JSON_DEPTH)}}]`;
    expect(parseImport(array, 'JSON', classification).errors).toEqual([
      { line: 2, message: `Nested more than ${MAX_JSON_DEPTH} levels deep` },
    ]);
    // just within the limit
    const fits = `[{"text":"x","extra":${deep(MAX_JSON_DEPTH - 1)}}]`;
    expect(parseImport(fits, 'JSON', classification).errors).toEqual([]);
  });

  it('are refused when a row holds too many values', () => {
    const many = JSON.stringify({ text: 'x', extra: Array.from({ length: 10_001 }, () => 1) });
    expect(parseImport(many, 'JSONL', classification).errors).toEqual([
      { line: 1, message: 'Holds more than 10000 values' },
    ]);
  });

  it('are refused in the columns of a re-imported csv export', () => {
    const header = 'task_id,external_id,annotator,answer,data';
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = [
      header,
      `t1,,ann_1,${cell('{"labels":["positive"]}')},${cell(`{"text":"a","x":${deep(100)}}`)}`,
      `t2,,consensus,${cell(`{"labels":${deep(100)}}`)},${cell('{"text":"b"}')}`,
    ].join('\n');
    expect(parseImport(csv, 'CSV', classification).errors).toEqual([
      { line: 2, message: `The data column: Nested more than ${MAX_JSON_DEPTH} levels deep` },
      { line: 3, message: `The answer column: Nested more than ${MAX_JSON_DEPTH} levels deep` },
    ]);
  });
});

describe('a gold answer in a re-imported csv export', () => {
  it('is reported on the row it came from, not on the first row of its task', () => {
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const data = cell('{"text":"a"}');
    const csv = [
      'task_id,external_id,annotator,answer,data',
      `t1,,ann_1,${cell('{"labels":["positive"]}')},${data}`,
      `t1,,ann_2,${cell('{"labels":["negative"]}')},${data}`,
      `t1,,consensus,${cell('{"labels":["nonsense"]}')},${data}`,
      `t2,,ann_1,${cell('{"labels":["positive"]}')},${cell('{"text":"b"}')}`,
      `t2,,consensus,${cell('{"labels":["positive"]}')},${cell('{"text":"b"}')}`,
    ].join('\n');
    const result = parseImport(csv, 'CSV', classification);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(4);
    expect(result.errors[0].message).toMatch(/^Gold answer: /);
    expect(result.rows.map((row) => row.line)).toEqual([5]);
  });
});
