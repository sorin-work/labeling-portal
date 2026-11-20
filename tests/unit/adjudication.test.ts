import { describe, expect, it } from 'vitest';

import {
  agreementExplained,
  consensusSource,
  decideCompletion,
  parseAdjudicationNote,
  parseAgreementThreshold,
  parseMaxExtraAnnotators,
} from '~/domain/adjudication';
import type { Answer } from '~/domain/answers';
import { consensus } from '~/domain/consensus';
import { SCHEMA_TEMPLATES, type TaskSchema } from '~/domain/task-schema';

const base = { overlap: 2, extraSlots: 0, threshold: 0.75, maxExtra: 1 };

describe('decideCompletion', () => {
  it('waits until the task has its overlap and its extra slots', () => {
    expect(decideCompletion({ ...base, accepted: 1, agreement: 1 })).toEqual({ step: 'wait' });
    expect(decideCompletion({ ...base, extraSlots: 1, accepted: 2, agreement: 0.5 })).toEqual({
      step: 'wait',
    });
  });

  it('completes everything while the threshold is off, or with an overlap of 1', () => {
    expect(decideCompletion({ ...base, threshold: null, accepted: 2, agreement: 0.5 })).toEqual({
      step: 'complete',
    });
    expect(decideCompletion({ ...base, overlap: 1, accepted: 1, agreement: 0 })).toEqual({
      step: 'complete',
    });
  });

  it('adds extras up to the maximum, then adjudicates', () => {
    expect(decideCompletion({ ...base, accepted: 2, agreement: 0.5 })).toEqual({ step: 'extra' });
    expect(decideCompletion({ ...base, extraSlots: 1, accepted: 3, agreement: 0.67 })).toEqual({
      step: 'adjudicate',
    });
    expect(decideCompletion({ ...base, maxExtra: 0, accepted: 2, agreement: 0.5 })).toEqual({
      step: 'adjudicate',
    });
  });

  it('compares in whole percentages, so two against one meets 67%', () => {
    const twoOfThree = { ...base, overlap: 3, accepted: 3, agreement: 0.6667 };
    expect(decideCompletion({ ...twoOfThree, threshold: 0.67 })).toEqual({ step: 'complete' });
    expect(decideCompletion({ ...twoOfThree, threshold: 0.68 })).toEqual({ step: 'extra' });
  });
});

describe('the number that is compared, per kind', () => {
  const decide = (schema: TaskSchema, answers: Answer[], threshold: number) =>
    decideCompletion({
      overlap: answers.length,
      extraSlots: 0,
      threshold,
      maxExtra: 1,
      accepted: answers.length,
      agreement: consensus(schema, answers).agreement,
    }).step;

  it('single label: a one against one split is 50%', () => {
    const schema = SCHEMA_TEMPLATES.text_classification;
    const split = [{ labels: ['positive'] }, { labels: ['negative'] }];
    expect(decide(schema, split, 0.51)).toBe('extra');
    expect(decide(schema, split, 0.5)).toBe('complete');
  });

  it('multi label: "a, b" against "a" is 75%', () => {
    const schema = { ...SCHEMA_TEMPLATES.text_classification, multiple: true };
    const answers = [{ labels: ['positive', 'negative'] }, { labels: ['positive'] }];
    expect(decide(schema, answers, 0.76)).toBe('extra');
    expect(decide(schema, answers, 0.75)).toBe('complete');
  });

  it('pairwise: two against one is 67%', () => {
    const schema = SCHEMA_TEMPLATES.pairwise;
    const keys = schema.dimensions.map((d) => d.key);
    const scores = Object.fromEntries(keys.map((k) => [k, 3]));
    const pick = (preference: 'A' | 'B') => ({
      preference,
      scores: { a: scores, b: scores },
      rationale: 'because it is clearer',
    });
    expect(decide(schema, [pick('A'), pick('A'), pick('B')], 0.7)).toBe('extra');
    expect(decide(schema, [pick('A'), pick('A'), pick('B')], 0.67)).toBe('complete');
  });

  it('entities: span F1 over the pairs', () => {
    const schema = SCHEMA_TEMPLATES.ner;
    const label = schema.entities[0].name;
    // one span shared, one extra on one side: F1 = 2 * 1 / (1 + 2) = 67%
    const answers = [
      { spans: [{ start: 0, end: 3, label }] },
      {
        spans: [
          { start: 0, end: 3, label },
          { start: 5, end: 8, label },
        ],
      },
    ];
    expect(decide(schema, answers, 0.7)).toBe('extra');
    expect(decide(schema, answers, 0.67)).toBe('complete');
  });

  it('boxes: box F1 over the pairs', () => {
    const schema = SCHEMA_TEMPLATES.bbox;
    const label = schema.labels[0];
    const box = { x: 10, y: 10, w: 50, h: 50, label };
    const far = { x: 200, y: 200, w: 50, h: 50, label };
    const size = { imageWidth: 400, imageHeight: 400 };
    // one box matched, one box only on one side: 67%
    expect(
      decide(
        schema,
        [
          { boxes: [box], ...size },
          { boxes: [box, far], ...size },
        ],
        0.7,
      ),
    ).toBe('extra');
    expect(
      decide(
        schema,
        [
          { boxes: [box], ...size },
          { boxes: [box, far], ...size },
        ],
        0.67,
      ),
    ).toBe('complete');
  });
});

describe('low agreement settings', () => {
  it('reads the threshold as a whole percentage, empty meaning off', () => {
    expect(parseAgreementThreshold('')).toEqual({ ok: true, value: null });
    expect(parseAgreementThreshold('67')).toEqual({ ok: true, value: 0.67 });
    expect(parseAgreementThreshold('80%')).toEqual({ ok: true, value: 0.8 });
    for (const bad of ['0', '101', '66.5', 'high'])
      expect(parseAgreementThreshold(bad).ok).toBe(false);
  });

  it('reads extra annotators from 0 to 3, 1 when the field is missing', () => {
    expect(parseMaxExtraAnnotators(null)).toEqual({ ok: true, value: 1 });
    expect(parseMaxExtraAnnotators('0')).toEqual({ ok: true, value: 0 });
    expect(parseMaxExtraAnnotators('3')).toEqual({ ok: true, value: 3 });
    for (const bad of ['', '4', '-1', '1.5']) expect(parseMaxExtraAnnotators(bad).ok).toBe(false);
  });

  it('needs a reason for an adjudication', () => {
    expect(parseAdjudicationNote('  ').ok).toBe(false);
    expect(parseAdjudicationNote(' sarcasm ')).toEqual({ ok: true, value: 'sarcasm' });
  });

  it('explains the number for every kind', () => {
    for (const schema of Object.values(SCHEMA_TEMPLATES)) {
      expect(agreementExplained(schema).length).toBeGreaterThan(20);
    }
  });

  it('names where a consensus came from', () => {
    const done = { status: 'COMPLETE', consensus: { labels: ['a'] } };
    expect(consensusSource({ ...done, adjudicatedAt: null })).toBe('majority');
    expect(consensusSource({ ...done, adjudicatedAt: new Date() })).toBe('adjudicated');
    expect(consensusSource({ ...done, consensus: null, adjudicatedAt: null })).toBeNull();
    expect(
      consensusSource({
        status: 'ADJUDICATION',
        consensus: { labels: ['a'] },
        adjudicatedAt: null,
      }),
    ).toBeNull();
  });
});
