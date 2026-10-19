import { describe, expect, it } from 'vitest';

import { detectFormat, parseImport } from '~/domain/import';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

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
