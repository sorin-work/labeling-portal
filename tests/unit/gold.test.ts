import { describe, expect, it } from 'vitest';

import { scoreAgainstGold } from '~/domain/gold';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

describe('scoreAgainstGold', () => {
  it('scores classification by label overlap', () => {
    const schema = { ...SCHEMA_TEMPLATES.text_classification, multiple: true };
    expect(scoreAgainstGold(schema, { labels: ['positive'] }, { labels: ['positive'] })).toBe(1);
    expect(scoreAgainstGold(schema, { labels: ['positive'] }, { labels: ['negative'] })).toBe(0);
    expect(
      scoreAgainstGold(schema, { labels: ['positive', 'neutral'] }, { labels: ['positive'] }),
    ).toBe(0.5);
  });

  it('scores entities with span f1', () => {
    const gold = {
      spans: [
        { start: 0, end: 5, label: 'PERSON' },
        { start: 10, end: 15, label: 'ORG' },
      ],
    };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.ner, gold, gold)).toBe(1);
    expect(
      scoreAgainstGold(
        SCHEMA_TEMPLATES.ner,
        { spans: [{ start: 0, end: 5, label: 'PERSON' }] },
        gold,
      ),
    ).toBe(0.6667);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.ner, { spans: [] }, { spans: [] })).toBe(1);
  });

  it('gives half credit for ties in pairwise preferences', () => {
    const vote = (preference: 'A' | 'B' | 'tie') => ({
      preference,
      scores: { a: {}, b: {} },
      rationale: '',
    });
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('A'), vote('A'))).toBe(1);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('tie'), vote('A'))).toBe(0.5);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.pairwise, vote('B'), vote('A'))).toBe(0);
  });

  it('never scores above 1 when gold boxes overlap', () => {
    const img = { imageWidth: 200, imageHeight: 200 };
    const gold = {
      ...img,
      boxes: [
        { x: 10, y: 10, w: 60, h: 40, label: 'car' },
        { x: 20, y: 10, w: 60, h: 40, label: 'car' },
      ],
    };
    const one = { ...img, boxes: [{ x: 15, y: 10, w: 60, h: 40, label: 'car' }] };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, one, gold)).toBe(0.6667);
  });

  it('scores boxes with box f1', () => {
    const img = { imageWidth: 200, imageHeight: 200 };
    const gold = {
      ...img,
      boxes: [
        { x: 10, y: 10, w: 40, h: 40, label: 'car' },
        { x: 120, y: 120, w: 30, h: 60, label: 'person' },
      ],
    };
    const answer = {
      ...img,
      boxes: [
        { x: 12, y: 11, w: 40, h: 38, label: 'car' },
        { x: 150, y: 10, w: 20, h: 20, label: 'person' },
      ],
    };
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, gold, gold)).toBe(1);
    expect(scoreAgainstGold(SCHEMA_TEMPLATES.bbox, answer, gold)).toBe(0.5);
  });
});
