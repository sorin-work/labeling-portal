import type { ReviewSample } from '@prisma/client';

/** How many of an annotator's submissions in a project are reviewed before sampling starts. */
export const ALWAYS_REVIEW_FIRST = 10;

export type SamplingInput = {
  /** the project's review share, 0 to 100 */
  samplePercent: number;
  /** submissions of this annotator in the project that already went to a reviewer */
  sentToReviewBefore: number;
  /** the quality page flags this annotator's gold accuracy */
  flagged: boolean;
};

export type SamplingDecision = {
  review: boolean;
  /** what gets stored on the submission; null when the project reviews everything */
  sample: ReviewSample | null;
};

/**
 * Decides whether a new submission goes to a reviewer. Called once, when the
 * work is submitted, and the result is stored. `random` returns a number from
 * 0 (inclusive) to 1 (exclusive) and is only called when the outcome is
 * really down to the draw.
 */
export function decideReview(input: SamplingInput, random: () => number): SamplingDecision {
  if (input.samplePercent >= 100) return { review: true, sample: null };
  if (input.sentToReviewBefore < ALWAYS_REVIEW_FIRST) {
    return { review: true, sample: 'NEW_ANNOTATOR' };
  }
  if (input.flagged) return { review: true, sample: 'FLAGGED' };
  return random() * 100 < input.samplePercent
    ? { review: true, sample: 'DRAWN' }
    : { review: false, sample: 'NOT_DRAWN' };
}

export const SAMPLE_LABELS: Record<ReviewSample, string> = {
  NEW_ANNOTATOR: `One of this annotator's first ${ALWAYS_REVIEW_FIRST} submissions`,
  FLAGGED: 'Annotator flagged for low gold accuracy',
  DRAWN: 'Picked by the review sample',
  NOT_DRAWN: 'Accepted without review, not in the sample',
};

/** The review setting of a project in a few words, for the overview. */
export function describeReviewPolicy(reviewRequired: boolean, samplePercent: number): string {
  if (!reviewRequired) return 'Optional';
  if (samplePercent >= 100) return 'Every submission';
  if (samplePercent <= 0) return 'New and flagged annotators only';
  return `${samplePercent}% sample`;
}

/** Reads the review share from a form value: 100 when the field is missing. */
export function readSamplePercent(raw: unknown): number {
  if (raw === null || raw === undefined) return 100;
  const text = String(raw).trim();
  return text === '' ? Number.NaN : Number(text);
}
