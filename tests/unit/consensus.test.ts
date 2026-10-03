import { describe, expect, it } from 'vitest';

import type { BboxAnswer, PairwiseAnswer } from '~/domain/answers';
import {
  bboxConsensus,
  boxF1,
  classificationConsensus,
  consensus,
  nerConsensus,
  pairwiseConsensus,
  spanF1,
} from '~/domain/consensus';
import { iou } from '~/domain/geometry';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

describe('iou', () => {
  it('is 1 for identical boxes and 0 for disjoint ones', () => {
    const box = { x: 0, y: 0, w: 10, h: 10 };
    expect(iou(box, box)).toBe(1);
    expect(iou(box, { x: 20, y: 20, w: 5, h: 5 })).toBe(0);
  });

  it('measures partial overlap', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(50 / 150);
  });
});

describe('classificationConsensus', () => {
  it('takes the majority label', () => {
    const result = classificationConsensus(
      [{ labels: ['pos'] }, { labels: ['pos'] }, { labels: ['neg'] }],
      false,
    );
    expect(result).toEqual({ answer: { labels: ['pos'] }, agreement: 0.6667, annotators: 3 });
  });

  it('returns no answer on a tie', () => {
    const result = classificationConsensus([{ labels: ['pos'] }, { labels: ['neg'] }], false);
    expect(result.answer).toBeNull();
    expect(result.agreement).toBe(0.5);
  });

  it('keeps multi-labels chosen by a majority', () => {
    const result = classificationConsensus(
      [{ labels: ['a', 'b'] }, { labels: ['a'] }, { labels: ['a', 'c'] }],
      true,
    );
    expect(result.answer).toEqual({ labels: ['a'] });
  });
});

describe('pairwiseConsensus', () => {
  const vote = (preference: 'A' | 'B' | 'tie', a: number, b: number): PairwiseAnswer => ({
    preference,
    scores: { a: { help: a }, b: { help: b } },
    rationale: 'because',
  });

  it('takes the majority preference and averages scores', () => {
    const result = pairwiseConsensus([vote('A', 4, 2), vote('A', 5, 3), vote('B', 3, 4)]);
    expect(result.answer).toEqual({
      preference: 'A',
      scores: { a: { help: 4 }, b: { help: 3 } },
      rationale: '',
    });
  });

  it('has no answer when votes split', () => {
    expect(pairwiseConsensus([vote('A', 4, 2), vote('B', 2, 4)]).answer).toBeNull();
  });
});

describe('nerConsensus', () => {
  it('keeps spans most annotators marked', () => {
    const a = { start: 0, end: 4, label: 'PERSON' };
    const b = { start: 10, end: 15, label: 'ORG' };
    const result = nerConsensus([{ spans: [a, b] }, { spans: [a] }, { spans: [a, b] }]);
    expect(result.answer).toEqual({ spans: [a, b] });
  });

  it('scores perfect agreement as 1', () => {
    const spans = [{ start: 0, end: 4, label: 'PERSON' }];
    expect(nerConsensus([{ spans }, { spans }]).agreement).toBe(1);
  });

  it('computes span f1', () => {
    expect(spanF1([], [])).toBe(1);
    expect(
      spanF1(
        [{ start: 0, end: 4, label: 'X' }],
        [
          { start: 0, end: 4, label: 'X' },
          { start: 5, end: 6, label: 'X' },
        ],
      ),
    ).toBeCloseTo(2 / 3);
  });
});

describe('bboxConsensus', () => {
  const answer = (boxes: BboxAnswer['boxes']): BboxAnswer => ({
    boxes,
    imageWidth: 100,
    imageHeight: 100,
  });

  it('averages boxes most annotators drew', () => {
    const result = bboxConsensus([
      answer([{ x: 10, y: 10, w: 20, h: 20, label: 'car' }]),
      answer([{ x: 12, y: 10, w: 20, h: 20, label: 'car' }]),
      answer([{ x: 60, y: 60, w: 10, h: 10, label: 'car' }]),
    ]);
    expect(result.answer).toEqual(answer([{ x: 11, y: 10, w: 20, h: 20, label: 'car' }]));
  });

  it('does not merge boxes with different labels', () => {
    const result = bboxConsensus([
      answer([{ x: 10, y: 10, w: 20, h: 20, label: 'car' }]),
      answer([{ x: 10, y: 10, w: 20, h: 20, label: 'person' }]),
    ]);
    expect((result.answer as BboxAnswer).boxes).toEqual([]);
    expect(result.agreement).toBe(0);
  });

  it('computes box f1 for separate objects', () => {
    const car = { x: 0, y: 0, w: 10, h: 10, label: 'car' };
    const person = { x: 50, y: 50, w: 10, h: 10, label: 'person' };
    expect(boxF1([car, person], [car, person])).toBe(1);
    expect(boxF1([car, person], [car])).toBeCloseTo(2 / 3);
  });
});

describe('consensus', () => {
  it('dispatches on the schema kind', () => {
    const result = consensus(SCHEMA_TEMPLATES.text_classification, [{ labels: ['neutral'] }]);
    expect(result.answer).toEqual({ labels: ['neutral'] });
  });
});

describe('consensus edge cases', () => {
  it('returns nothing without answers', () => {
    expect(classificationConsensus([], false)).toEqual({
      answer: null,
      agreement: 0,
      annotators: 0,
    });
    expect(nerConsensus([])).toEqual({ answer: null, agreement: 0, annotators: 0 });
    expect(bboxConsensus([]).answer).toBeNull();
  });

  it('keeps a single annotator’s answer as is', () => {
    const spans = [{ start: 2, end: 6, label: 'ORG' }];
    expect(nerConsensus([{ spans }])).toEqual({ answer: { spans }, agreement: 1, annotators: 1 });
  });

  it('treats a tie vote as a preference of its own', () => {
    const vote = (preference: 'A' | 'B' | 'tie'): PairwiseAnswer => ({
      preference,
      scores: { a: { h: 3 }, b: { h: 3 } },
      rationale: '',
    });
    const result = pairwiseConsensus([vote('tie'), vote('tie'), vote('A')]);
    expect(result.answer).toMatchObject({ preference: 'tie' });
    expect(result.agreement).toBeCloseTo(0.6667);
  });

  it('allows an empty multi-label consensus when nobody agrees', () => {
    const result = classificationConsensus(
      [{ labels: ['a'] }, { labels: ['b'] }, { labels: ['c'] }],
      true,
    );
    expect(result.answer).toEqual({ labels: [] });
  });

  it('agrees fully when nobody drew a box', () => {
    const empty = { boxes: [], imageWidth: 10, imageHeight: 10 };
    expect(bboxConsensus([empty, empty]).agreement).toBe(1);
  });
});
