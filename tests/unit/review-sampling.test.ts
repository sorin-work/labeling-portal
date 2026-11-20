import { describe, expect, it, vi } from 'vitest';

import {
  ALWAYS_REVIEW_FIRST,
  decideReview,
  describeReviewPolicy,
  readSamplePercent,
} from '~/domain/review-sampling';

const settled = { samplePercent: 25, sentToReviewBefore: ALWAYS_REVIEW_FIRST, flagged: false };

describe('decideReview', () => {
  it('reviews everything at 100 percent without drawing', () => {
    const random = vi.fn(() => 0.99);
    expect(decideReview({ ...settled, samplePercent: 100 }, random)).toEqual({
      review: true,
      sample: null,
    });
    expect(random).not.toHaveBeenCalled();
  });

  it('draws once for an annotator who is past the first submissions', () => {
    const low = vi.fn(() => 0.2);
    expect(decideReview(settled, low)).toEqual({ review: true, sample: 'DRAWN' });
    expect(low).toHaveBeenCalledTimes(1);
    expect(decideReview(settled, () => 0.8)).toEqual({ review: false, sample: 'NOT_DRAWN' });
  });

  it('puts the boundary on the side of not reviewing', () => {
    expect(decideReview(settled, () => 0.2499).review).toBe(true);
    expect(decideReview(settled, () => 0.25).review).toBe(false);
  });

  it('always reviews the first submissions of an annotator', () => {
    const random = vi.fn(() => 0.99);
    for (let before = 0; before < ALWAYS_REVIEW_FIRST; before++) {
      expect(decideReview({ ...settled, sentToReviewBefore: before }, random)).toEqual({
        review: true,
        sample: 'NEW_ANNOTATOR',
      });
    }
    expect(random).not.toHaveBeenCalled();
    expect(decideReview(settled, random).review).toBe(false);
  });

  it('always reviews a flagged annotator', () => {
    const random = vi.fn(() => 0.99);
    expect(decideReview({ ...settled, flagged: true }, random)).toEqual({
      review: true,
      sample: 'FLAGGED',
    });
    expect(random).not.toHaveBeenCalled();
  });

  it('never draws anything in at zero percent', () => {
    expect(decideReview({ ...settled, samplePercent: 0 }, () => 0)).toEqual({
      review: false,
      sample: 'NOT_DRAWN',
    });
    expect(decideReview({ ...settled, samplePercent: 0, flagged: true }, () => 0).review).toBe(
      true,
    );
  });

  it('reviews about the configured share over many draws', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    let reviewed = 0;
    for (let i = 0; i < 4000; i++) if (decideReview(settled, random).review) reviewed += 1;
    expect(reviewed / 4000).toBeGreaterThan(0.22);
    expect(reviewed / 4000).toBeLessThan(0.28);
  });
});

describe('describeReviewPolicy', () => {
  it('names the setting', () => {
    expect(describeReviewPolicy(false, 100)).toBe('Optional');
    expect(describeReviewPolicy(false, 20)).toBe('Optional');
    expect(describeReviewPolicy(true, 100)).toBe('Every submission');
    expect(describeReviewPolicy(true, 20)).toBe('20% sample');
    expect(describeReviewPolicy(true, 0)).toBe('New and flagged annotators only');
  });
});

describe('readSamplePercent', () => {
  it('reviews everything when the form has no such field', () => {
    expect(readSamplePercent(null)).toBe(100);
    expect(readSamplePercent(undefined)).toBe(100);
  });

  it('does not read an emptied field as zero', () => {
    expect(readSamplePercent('  ')).toBeNaN();
    expect(readSamplePercent('0')).toBe(0);
    expect(readSamplePercent('35')).toBe(35);
  });
});
