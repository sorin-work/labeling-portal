import type { ReviewStatus } from '@prisma/client';

/** Review states that count a submission as finished work. */
export const ACCEPTED_STATUSES: readonly ReviewStatus[] = ['APPROVED', 'FIXED', 'NOT_REQUIRED'];

export function isAccepted(status: ReviewStatus | null | undefined): boolean {
  return status != null && ACCEPTED_STATUSES.includes(status);
}

type ReviewLike = { decision: string; correctedAnswer: unknown; createdAt: Date | string };

/**
 * The answer that counts for a submission: the most recent reviewer correction
 * if there is one, otherwise what the annotator submitted.
 */
export function finalAnswer<T = unknown>(answer: unknown, reviews: ReviewLike[]): T {
  const fixes = reviews
    .filter((r) => r.decision === 'FIX' && r.correctedAnswer != null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return (fixes[0]?.correctedAnswer ?? answer) as T;
}
