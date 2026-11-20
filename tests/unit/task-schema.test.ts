import { describe, expect, it } from 'vitest';

import {
  isImageKind,
  mainField,
  parseTaskSchema,
  requiredFields,
  SCHEMA_TEMPLATES,
} from '~/domain/task-schema';

describe('parseTaskSchema', () => {
  it('accepts every built-in template', () => {
    for (const template of Object.values(SCHEMA_TEMPLATES)) {
      expect(parseTaskSchema(JSON.stringify(template))).toMatchObject({ ok: true });
    }
  });

  it('fills defaults', () => {
    const result = parseTaskSchema({
      kind: 'text_classification',
      textField: 'body',
      labels: ['spam', 'ham'],
    });
    expect(result).toEqual({
      ok: true,
      schema: {
        kind: 'text_classification',
        textField: 'body',
        labels: ['spam', 'ham'],
        multiple: false,
      },
    });
  });

  it('reports invalid json', () => {
    expect(parseTaskSchema('{nope')).toEqual({
      ok: false,
      errors: ['The schema is not valid JSON'],
    });
  });

  it('rejects unknown kinds', () => {
    const result = parseTaskSchema({ kind: 'audio', field: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate labels regardless of case', () => {
    const result = parseTaskSchema({
      kind: 'text_classification',
      textField: 'text',
      labels: ['Yes', 'yes'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/Duplicate label/);
  });

  it('needs at least two classification labels', () => {
    const result = parseTaskSchema({
      kind: 'text_classification',
      textField: 'text',
      labels: ['a'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('labels: Add at least two labels');
  });

  it('validates entity colours', () => {
    const result = parseTaskSchema({
      kind: 'ner',
      textField: 'text',
      entities: [{ name: 'X', color: 'red' }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects field names with spaces', () => {
    const result = parseTaskSchema({ kind: 'bbox', imageField: 'image url', labels: ['car'] });
    expect(result.ok).toBe(false);
  });
});

describe('requiredFields', () => {
  it('lists the fields each kind reads', () => {
    expect(requiredFields(SCHEMA_TEMPLATES.text_classification)).toEqual(['text']);
    expect(requiredFields(SCHEMA_TEMPLATES.pairwise)).toEqual([
      'prompt',
      'response_a',
      'response_b',
    ]);
    expect(requiredFields(SCHEMA_TEMPLATES.bbox)).toEqual(['image_url']);
  });
});

describe('image classification', () => {
  it('needs an image field and two labels, and fills `multiple`', () => {
    expect(
      parseTaskSchema({ kind: 'image_classification', imageField: 'url', labels: ['a', 'b'] }),
    ).toEqual({
      ok: true,
      schema: {
        kind: 'image_classification',
        imageField: 'url',
        labels: ['a', 'b'],
        multiple: false,
      },
    });
    expect(
      parseTaskSchema({ kind: 'image_classification', imageField: 'url', labels: ['a'] }),
    ).toMatchObject({ ok: false });
    expect(requiredFields(SCHEMA_TEMPLATES.image_classification)).toEqual(['image_url']);
  });

  it('names the image as the field that stands for a task, as boxes do', () => {
    expect(mainField(SCHEMA_TEMPLATES.image_classification)).toBe('image_url');
    expect(mainField(SCHEMA_TEMPLATES.text_classification)).toBe('text');
    expect(isImageKind(SCHEMA_TEMPLATES.image_classification)).toBe(true);
    expect(isImageKind(SCHEMA_TEMPLATES.ner)).toBe(false);
  });
});
