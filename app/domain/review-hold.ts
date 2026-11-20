/** How long a hold lasts from the moment it was taken or last renewed. */
export const REVIEW_HOLD_MINUTES = 15;

const HOLD_MS = REVIEW_HOLD_MINUTES * 60_000;

/**
 * How often the review page renews the reviewer's hold while they work, so a
 * long review or fix does not lose the submission to the next reviewer.
 */
export const HOLD_RENEW_MINUTES = 5;

/**
 * Whether the review page should renew the hold at this check: only for a
 * reviewer who has the page in front of them and touched it since the last
 * check. A tab left open stops renewing, and its hold lapses.
 */
export function shouldRenewHold(
  page: { visible: boolean; lastInputAt: number },
  now: number,
): boolean {
  return page.visible && now - page.lastInputAt <= HOLD_RENEW_MINUTES * 60_000;
}

/** Holds taken at or before this moment have lapsed. */
export function holdCutoff(now: Date): Date {
  return new Date(now.getTime() - HOLD_MS);
}

export function holdExpiresAt(heldAt: Date): Date {
  return new Date(heldAt.getTime() + HOLD_MS);
}

type HoldLike = {
  reviewHeldById: string | null;
  reviewHeldAt: Date | null;
  reviewHeldBy?: { name: string } | null;
};

export type ActiveHold = { reviewerId: string; reviewer: string; mine: boolean; until: Date };

/**
 * The reservation on a submission as `viewerId` sees it, or null when nobody
 * holds it or the hold has lapsed.
 */
export function activeHold(row: HoldLike, viewerId: string, now: Date): ActiveHold | null {
  if (!row.reviewHeldById || !row.reviewHeldAt) return null;
  const until = holdExpiresAt(row.reviewHeldAt);
  if (until <= now) return null;
  return {
    reviewerId: row.reviewHeldById,
    reviewer: row.reviewHeldBy?.name ?? 'Another reviewer',
    mine: row.reviewHeldById === viewerId,
    until,
  };
}
