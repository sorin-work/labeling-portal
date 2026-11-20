import { describe, expect, it } from 'vitest';

import {
  clampActiveSeconds,
  CREDIT_WINDOW_MS,
  creditHorizon,
  creditTime,
  mergeIntervals,
  type Interval,
  MAX_CREDITED_LIMITS,
  revisionCap,
  revisionSeconds,
} from '~/domain/active-time';

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

describe('revisionCap', () => {
  it('is one time limit while the total has room, and what is left after that', () => {
    expect(revisionCap(LIMIT, 0)).toBe(LIMIT);
    expect(revisionCap(LIMIT, MAX_CREDITED_LIMITS * LIMIT - 100)).toBe(100);
    expect(revisionCap(LIMIT, MAX_CREDITED_LIMITS * LIMIT + 5)).toBe(0);
    expect(revisionCap(Number.NaN, 0)).toBe(0);
  });
});

describe('creditTime', () => {
  const at = (minutes: number) => minutesLater(minutes);
  const span = (from: number, to: number) => ({ start: at(from), end: at(to) });

  /** Credits one piece of work after another, keeping the stretches as the server does. */
  function credits(
    work: Array<{ reported: number; start: number; now: number; cap?: number }>,
  ): number[] {
    let credited: Interval[] = [];
    return work.map(({ reported, start, now, cap }) => {
      const credit = creditTime({ reported, start: at(start), now: at(now), credited, cap });
      credited = mergeIntervals([...credited, ...credit.pieces]);
      return credit.seconds;
    });
  }

  it('credits three revisions sent back together no more than the time that passed once', () => {
    const together = { reported: 1200, start: 0, now: 20 };
    expect(credits([together, together, together])).toEqual([1200, 0, 0]);
  });

  it('pays a claim in full when later-started work was handed in first', () => {
    // claimed at 0; a send-back from minute 10 revised and handed in at 15;
    // the claim handed in at 30 after 25 minutes of work
    expect(
      credits([
        { reported: 300, start: 10, now: 15, cap: LIMIT },
        { reported: 1500, start: 0, now: 30 },
      ]),
    ).toEqual([300, 1500]);
  });

  it('pays each minute of overlapping windows once', () => {
    const paid = credits([
      { reported: 1200, start: 0, now: 20 },
      { reported: 1200, start: 10, now: 25 },
      { reported: 1200, start: 0, now: 30 },
    ]);
    // 20 minutes, then the 5 free ones of the second window, then the last 5
    expect(paid).toEqual([1200, 300, 300]);
    expect(paid.reduce((a, b) => a + b, 0)).toBe(30 * 60);
  });

  it('takes the earliest free time of the window, and stores what it took', () => {
    const credit = creditTime({
      reported: 900,
      start: at(0),
      now: at(30),
      credited: [span(5, 10), span(12, 20)],
    });
    expect(credit.seconds).toBe(900);
    expect(credit.pieces).toEqual([span(0, 5), span(10, 12), span(20, 28)]);
  });

  it('counts nothing from before the work could start, or before the horizon', () => {
    expect(creditTime({ reported: 9999, start: at(50), now: at(60), credited: [] }).seconds).toBe(
      600,
    );
    const now = at(2 * 24 * 60);
    const old = creditTime({ reported: 1e9, start: at(0), now, credited: [] });
    expect(old.seconds).toBe(CREDIT_WINDOW_MS / 1000);
    expect(old.pieces[0].start).toEqual(creditHorizon(now));
  });

  it('holds to the cap and takes nothing when nothing is credited', () => {
    expect(
      creditTime({ reported: 9999, start: at(0), now: at(60), credited: [], cap: 120 }),
    ).toEqual({ seconds: 120, pieces: [span(0, 2)] });
    for (const reported of [0, -5, Number.NaN]) {
      expect(creditTime({ reported, start: at(0), now: at(60), credited: [] })).toEqual({
        seconds: 0,
        pieces: [],
      });
    }
    expect(
      creditTime({ reported: 60, start: at(0), now: at(60), credited: [], cap: Number.NaN }),
    ).toEqual({ seconds: 0, pieces: [] });
    // a window that is all taken
    expect(
      creditTime({ reported: 60, start: at(0), now: at(60), credited: [span(0, 60)] }),
    ).toEqual({ seconds: 0, pieces: [] });
  });
});

describe('mergeIntervals', () => {
  const span = (from: number, to: number) => ({
    start: minutesLater(from),
    end: minutesLater(to),
  });

  it('sorts, joins overlapping and touching stretches and drops empty ones', () => {
    expect(
      mergeIntervals([span(20, 30), span(0, 5), span(5, 10), span(8, 12), span(40, 40)]),
    ).toEqual([span(0, 12), span(20, 30)]);
  });
});
