import { describe, expect, it } from 'vitest';

import { hasPassed, scoreQualification } from '~/domain/qualification';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

const schema = SCHEMA_TEMPLATES.text_classification;
const item = (answer: string, gold: string) => ({
  answer: { labels: [answer] },
  gold: { labels: [gold] },
});

describe('scoreQualification', () => {
  it('averages item scores as a percentage', () => {
    const result = scoreQualification(schema, [
      item('positive', 'positive'),
      item('neutral', 'negative'),
      item('negative', 'negative'),
    ]);
    expect(result).toEqual({ scorePercent: 66.7, perItem: [1, 0, 1] });
  });

  it('scores an empty test as zero', () => {
    expect(scoreQualification(schema, []).scorePercent).toBe(0);
  });
});

describe('hasPassed', () => {
  it('compares against the pass mark', () => {
    expect(hasPassed(90, 80)).toBe(true);
    expect(hasPassed(60, 80)).toBe(false);
  });

  it('passes a score equal to the pass mark', () => {
    expect(hasPassed(80, 80)).toBe(true);
    expect(hasPassed(100, 100)).toBe(true);
    expect(hasPassed(79.9, 80)).toBe(false);
  });
});
