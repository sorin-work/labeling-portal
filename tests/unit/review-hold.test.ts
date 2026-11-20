import { describe, expect, it } from 'vitest';

import { activeHold, holdCutoff, holdExpiresAt, REVIEW_HOLD_MINUTES } from '~/domain/review-hold';

const heldAt = new Date('2026-03-01T10:00:00Z');
const minutesLater = (m: number) => new Date(heldAt.getTime() + m * 60_000);
const row = { reviewHeldById: 'rev-1', reviewHeldAt: heldAt, reviewHeldBy: { name: 'Rafael' } };

describe('review holds', () => {
  it('last fifteen minutes', () => {
    expect(REVIEW_HOLD_MINUTES).toBe(15);
    expect(holdExpiresAt(heldAt)).toEqual(minutesLater(15));
    expect(holdCutoff(minutesLater(15))).toEqual(heldAt);
  });

  it('tells the holder from other reviewers', () => {
    expect(activeHold(row, 'rev-1', minutesLater(5))).toEqual({
      reviewerId: 'rev-1',
      reviewer: 'Rafael',
      mine: true,
      until: minutesLater(15),
    });
    expect(activeHold(row, 'rev-2', minutesLater(5))).toMatchObject({ mine: false });
  });

  it('lapses exactly when the cutoff used by the queue reaches it', () => {
    const justBefore = new Date(minutesLater(15).getTime() - 1);
    expect(activeHold(row, 'rev-2', justBefore)).not.toBeNull();
    expect(heldAt > holdCutoff(justBefore)).toBe(true);

    expect(activeHold(row, 'rev-2', minutesLater(15))).toBeNull();
    expect(heldAt <= holdCutoff(minutesLater(15))).toBe(true);
  });

  it('is empty when nobody holds the submission', () => {
    expect(activeHold({ reviewHeldById: null, reviewHeldAt: null }, 'rev-1', heldAt)).toBeNull();
  });
});
