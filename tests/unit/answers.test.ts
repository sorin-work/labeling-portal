import { describe, expect, it } from 'vitest';

import { parseAnswerJson, validateAnswer } from '~/domain/answers';
import { SCHEMA_TEMPLATES, type TextClassificationSchema } from '~/domain/task-schema';

const single = SCHEMA_TEMPLATES.text_classification;
const multi: TextClassificationSchema = { ...single, multiple: true };
const ner = SCHEMA_TEMPLATES.ner;
const pairwise = SCHEMA_TEMPLATES.pairwise;
const bbox = SCHEMA_TEMPLATES.bbox;

describe('classification answers', () => {
  it('accepts a known label', () => {
    expect(validateAnswer(single, {}, { labels: ['neutral'] })).toEqual({
      ok: true,
      answer: { labels: ['neutral'] },
    });
  });

  it('rejects unknown and missing labels', () => {
    expect(validateAnswer(single, {}, { labels: ['meh'] })).toEqual({
      ok: false,
      error: 'Unknown label: meh',
    });
    expect(validateAnswer(single, {}, { labels: [] }).ok).toBe(false);
    expect(validateAnswer(single, {}, null).ok).toBe(false);
  });

  it('allows several labels only in multi-label projects', () => {
    expect(validateAnswer(single, {}, { labels: ['positive', 'negative'] }).ok).toBe(false);
    expect(validateAnswer(multi, {}, { labels: ['negative', 'positive', 'negative'] })).toEqual({
      ok: true,
      answer: { labels: ['positive', 'negative'] },
    });
  });
});

describe('ner answers', () => {
  const data = { text: 'Ada Lovelace met Babbage in London.' };

  it('accepts spans inside the text and sorts them', () => {
    const result = validateAnswer(ner, data, {
      spans: [
        { start: 27, end: 33, label: 'LOCATION' },
        { start: 0, end: 12, label: 'PERSON' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      answer: {
        spans: [
          { start: 0, end: 12, label: 'PERSON' },
          { start: 27, end: 33, label: 'LOCATION' },
        ],
      },
    });
  });

  it('accepts an empty answer when nothing is mentioned', () => {
    expect(validateAnswer(ner, data, { spans: [] }).ok).toBe(true);
  });

  it('rejects spans outside the text, overlapping or with unknown labels', () => {
    expect(validateAnswer(ner, data, { spans: [{ start: 30, end: 99, label: 'PERSON' }] }).ok).toBe(
      false,
    );
    expect(validateAnswer(ner, data, { spans: [{ start: 3, end: 3, label: 'PERSON' }] }).ok).toBe(
      false,
    );
    expect(
      validateAnswer(ner, data, {
        spans: [
          { start: 0, end: 5, label: 'PERSON' },
          { start: 4, end: 12, label: 'PERSON' },
        ],
      }),
    ).toEqual({ ok: false, error: 'Spans cannot overlap' });
    expect(validateAnswer(ner, data, { spans: [{ start: 0, end: 3, label: 'DATE' }] }).ok).toBe(
      false,
    );
  });
});

describe('pairwise answers', () => {
  const scores = { helpfulness: 4, accuracy: 5, safety: 5 };
  const good = {
    preference: 'A',
    scores: { a: scores, b: { helpfulness: 2, accuracy: 3, safety: 5 } },
    rationale: '  A answers the question directly and B misses the point.  ',
  };

  it('accepts a complete rubric and trims the rationale', () => {
    const result = validateAnswer(pairwise, {}, good);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.answer as { rationale: string }).rationale).toMatch(/^A answers/);
  });

  it('needs every dimension scored for both sides', () => {
    const result = validateAnswer(
      pairwise,
      {},
      { ...good, scores: { a: scores, b: { helpfulness: 2 } } },
    );
    expect(result).toEqual({ ok: false, error: 'Score Accuracy for both responses' });
  });

  it('rejects scores outside 1-5', () => {
    expect(
      validateAnswer(pairwise, {}, { ...good, scores: { a: { ...scores, safety: 6 }, b: scores } })
        .ok,
    ).toBe(false);
  });

  it('enforces the rationale length', () => {
    expect(validateAnswer(pairwise, {}, { ...good, rationale: 'B' }).ok).toBe(false);
  });

  it('refuses ties when the schema does not allow them', () => {
    const strict = { ...pairwise, allowTie: false };
    expect(validateAnswer(strict, {}, { ...good, preference: 'tie' })).toEqual({
      ok: false,
      error: 'Ties are not allowed here',
    });
  });
});

describe('bounding box answers', () => {
  it('clamps boxes to the image', () => {
    const result = validateAnswer(
      bbox,
      {},
      {
        imageWidth: 100,
        imageHeight: 50,
        boxes: [{ x: -2, y: 10.04, w: 120, h: 20, label: 'car' }],
      },
    );
    expect(result).toEqual({
      ok: true,
      answer: {
        imageWidth: 100,
        imageHeight: 50,
        boxes: [{ x: 0, y: 10, w: 100, h: 20, label: 'car' }],
      },
    });
  });

  it('rejects tiny boxes and unknown labels', () => {
    const base = { imageWidth: 100, imageHeight: 100 };
    expect(
      validateAnswer(bbox, {}, { ...base, boxes: [{ x: 1, y: 1, w: 2, h: 2, label: 'car' }] }).ok,
    ).toBe(false);
    expect(
      validateAnswer(bbox, {}, { ...base, boxes: [{ x: 1, y: 1, w: 20, h: 20, label: 'dog' }] }).ok,
    ).toBe(false);
  });
});

describe('parseAnswerJson', () => {
  it('decodes json and tolerates garbage', () => {
    expect(parseAnswerJson('{"labels":["a"]}')).toEqual({ labels: ['a'] });
    expect(parseAnswerJson('{')).toBeNull();
    expect(parseAnswerJson(null)).toBeNull();
  });
});
