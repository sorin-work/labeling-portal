/** How long a reviewer keeps a submission to themselves without deciding. */
export const REVIEW_HOLD_MINUTES = 15;

const HOLD_MS = REVIEW_HOLD_MINUTES * 60_000;

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
