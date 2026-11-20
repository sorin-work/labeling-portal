import { describe, expect, it } from 'vitest';

import { clampActiveSeconds, MAX_CREDITED_LIMITS, revisionSeconds } from '~/domain/active-time';

const reviewedAt = new Date('2026-03-10T10:00:00Z');
const minutesLater = (minutes: number) => new Date(reviewedAt.getTime() + minutes * 60_000);
const LIMIT = 30 * 60;

describe('clampActiveSeconds', () => {
  it('never credits more than the time that has passed', () => {
    expect(clampActiveSeconds(90, reviewedAt, minutesLater(2))).toBe(90);
    expect(clampActiveSeconds(9999, reviewedAt, minutesLater(2))).toBe(120);
    expect(clampActiveSeconds(12.9, reviewedAt, minutesLater(2))).toBe(12);
  });

  it('credits nothing for values that are not a time', () => {
    for (const reported of [-5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(clampActiveSeconds(reported, reviewedAt, minutesLater(2))).toBe(0);
    }
    // a clock that went backwards
    expect(clampActiveSeconds(60, minutesLater(5), reviewedAt)).toBe(0);
  });
});

describe('revisionSeconds', () => {
  const revise = (reported: number, minutes: number, credited = 0, limitSeconds = LIMIT) =>
    revisionSeconds({ reported, reviewedAt, now: minutesLater(minutes), limitSeconds, credited });

  it('credits the reported time while it is plausible', () => {
    expect(revise(240, 10)).toBe(240);
    expect(revise(600, 10)).toBe(600);
  });

  it('never credits more than the time since the review', () => {
    expect(revise(9_999_999, 4)).toBe(240);
  });

  it('never credits more than the time limit for one revision, however long ago the review was', () => {
    const fiveDays = 5 * 24 * 60;
    expect(revise(9_999_999, fiveDays)).toBe(LIMIT);
    expect(revise(432_000, fiveDays)).toBe(LIMIT);
    expect(revise(LIMIT + 1, fiveDays)).toBe(LIMIT);
  });

  it('never lets an assignment pass the total, however often it is sent back', () => {
    const total = MAX_CREDITED_LIMITS * LIMIT;
    const aDay = 24 * 60;
    let credited = 2 * LIMIT; // a first submission that used its extension
    const rounds = [];
    for (let round = 0; round < 5; round++) {
      const more = revise(9_999_999, aDay, credited);
      rounds.push(more);
      credited += more;
    }
    expect(rounds).toEqual([LIMIT, 0, 0, 0, 0]);
    expect(credited).toBe(total);
    // already past it, from before the limit existed: nothing more, and nothing negative
    expect(revise(600, aDay, total + 500)).toBe(0);
  });

  it('credits part of a revision when only part is left', () => {
    expect(revise(900, 60, MAX_CREDITED_LIMITS * LIMIT - 100)).toBe(100);
  });

  it('credits nothing for values that are not a time, or without a limit', () => {
    expect(revise(Number.NaN, 60)).toBe(0);
    expect(revise(-1, 60)).toBe(0);
    expect(revise(600, 60, 0, 0)).toBe(0);
    expect(revise(600, 60, 0, Number.NaN)).toBe(0);
    expect(revise(600, 60, Number.NaN)).toBe(0);
  });

  it('returns whole seconds', () => {
    expect(revise(100.7, 60)).toBe(100);
    expect(Number.isInteger(revise(9_999_999, 60, 17, 90.5))).toBe(true);
  });
});
