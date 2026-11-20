import { describe, expect, it } from 'vitest';

import {
  activeHold,
  HOLD_RENEW_MINUTES,
  holdCutoff,
  holdExpiresAt,
  REVIEW_HOLD_MINUTES,
  shouldRenewHold,
} from '~/domain/review-hold';

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

describe('shouldRenewHold', () => {
  const now = Date.parse('2026-03-01T10:20:00Z');
  const minutesAgo = (m: number) => now - m * 60_000;

  it('renews for a reviewer who is at the page and touched it since the last check', () => {
    expect(shouldRenewHold({ visible: true, lastInputAt: minutesAgo(1) }, now)).toBe(true);
    expect(
      shouldRenewHold({ visible: true, lastInputAt: minutesAgo(HOLD_RENEW_MINUTES) }, now),
    ).toBe(true);
  });

  it('lets the hold of a tab that was left alone or put away run out', () => {
    expect(
      shouldRenewHold({ visible: true, lastInputAt: minutesAgo(HOLD_RENEW_MINUTES + 1) }, now),
    ).toBe(false);
    expect(shouldRenewHold({ visible: false, lastInputAt: minutesAgo(1) }, now)).toBe(false);
  });

  it('checks often enough that a working reviewer never runs out', () => {
    expect(HOLD_RENEW_MINUTES * 2).toBeLessThan(REVIEW_HOLD_MINUTES);
  });
});
