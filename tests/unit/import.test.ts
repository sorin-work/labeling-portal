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
