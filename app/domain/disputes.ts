import type { DisputeStatus, ReviewDecision, ReviewStatus } from '@prisma/client';

const DAY = 24 * 60 * 60 * 1000;

/** Days an annotator has to dispute a review unless the project says otherwise. */
export const DEFAULT_DISPUTE_WINDOW_DAYS = 14;

export const MAX_DISPUTE_TEXT = 2000;

/**
 * The last moment a decision can be disputed, or null when the project does
 * not take disputes (a window of 0 days).
 */
export function disputeDeadline(decidedAt: Date, windowDays: number): Date | null {
  return windowDays > 0 ? new Date(decidedAt.getTime() + windowDays * DAY) : null;
}

/** The decision a submission in this review state rests on, if it can be disputed at all. */
const DISPUTABLE: Partial<Record<ReviewStatus, ReviewDecision>> = {
  SENT_BACK: 'SEND_BACK',
  FIXED: 'FIX',
};

export type DisputeRefusal =
  'not_disputable' | 'own_decision' | 'already_disputed' | 'disabled' | 'too_late' | 'no_resolver';

export type DisputableInput = {
  reviewStatus: ReviewStatus | null;
  /** the latest decision on the submission */
  review: {
    decision: ReviewDecision;
    reviewerId: string;
    createdAt: Date;
    overturnedAt: Date | null;
    disputed: boolean;
  } | null;
  openerId: string;
  windowDays: number;
  /**
   * how many people could settle a dispute on this decision: everyone who can
   * review in the project, apart from the reviewer who decided and the annotator
   */
  resolvers: number;
};

/**
 * Why the annotator cannot dispute the latest decision on their submission,
 * or null when they can. Only work that was sent back or fixed qualifies, a
 * decision can be disputed once, only inside the project's window, and only
 * while somebody is there who may settle it: a dispute nobody can settle
 * would block the work for good.
 */
export function disputeRefusal(input: DisputableInput, now: Date): DisputeRefusal | null {
  const { review } = input;
  const expected = input.reviewStatus ? DISPUTABLE[input.reviewStatus] : undefined;
  if (!review || !expected || review.decision !== expected || review.overturnedAt) {
    return 'not_disputable';
  }
  if (review.reviewerId === input.openerId) return 'own_decision';
  if (review.disputed) return 'already_disputed';
  const deadline = disputeDeadline(review.createdAt, input.windowDays);
  if (!deadline) return 'disabled';
  if (now > deadline) return 'too_late';
  return input.resolvers > 0 ? null : 'no_resolver';
}

export const DISPUTE_REFUSALS: Record<DisputeRefusal, string> = {
  not_disputable: 'Only work that was sent back or corrected can be disputed.',
  own_decision: 'You cannot dispute a decision you made yourself.',
  already_disputed: 'This decision has already been disputed.',
  disabled: 'This project does not take disputes.',
  too_late: 'The time to dispute this decision has passed.',
  no_resolver:
    'Nobody could settle a dispute on this decision: the reviewer who made it is the only other person who can review in this project. Ask a manager to add a reviewer, or revise the work.',
};

type DisputeRecord = {
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy?: { name: string } | null;
};

/**
 * What the annotator's page shows about disputing the latest decision on
 * their submission: the dispute they opened, or until when they can open
 * one, or that the time for it has passed.
 */
export function annotatorDisputeState(
  submission: {
    reviewStatus: ReviewStatus | null;
    annotatorId: string;
    review:
      | (Omit<NonNullable<DisputableInput['review']>, 'disputed'> & {
          dispute: DisputeRecord | null;
        })
      | null;
    windowDays: number;
    resolvers: number;
  },
  now: Date,
) {
  const { review, windowDays } = submission;
  const dispute = review?.dispute ?? null;
  const refusal = disputeRefusal(
    {
      reviewStatus: submission.reviewStatus,
      review: review && { ...review, disputed: dispute !== null },
      openerId: submission.annotatorId,
      windowDays,
      resolvers: submission.resolvers,
    },
    now,
  );
  return {
    dispute: dispute && {
      status: dispute.status,
      reason: dispute.reason,
      resolution: dispute.resolution,
      resolver: dispute.resolvedBy?.name ?? null,
      openedAt: dispute.createdAt,
      resolvedAt: dispute.resolvedAt,
    },
    disputeUntil: review && !refusal ? disputeDeadline(review.createdAt, windowDays) : null,
    disputeClosed:
      refusal === 'too_late' || refusal === 'no_resolver' ? DISPUTE_REFUSALS[refusal] : null,
  };
}

export type ResolverRefusal = 'own_decision' | 'own_work';

/** A dispute is settled by someone who neither made the decision nor did the work. */
export function resolverRefusal(input: {
  resolverId: string;
  reviewerId: string;
  annotatorId: string;
}): ResolverRefusal | null {
  if (input.resolverId === input.reviewerId) return 'own_decision';
  if (input.resolverId === input.annotatorId) return 'own_work';
  return null;
}

export const RESOLVER_REFUSALS: Record<ResolverRefusal, string> = {
  own_decision: 'You made this decision, so someone else has to settle the dispute.',
  own_work: 'This dispute is about your own work, so someone else has to settle it.',
};

type TextResult = { ok: true; text: string } | { ok: false; error: string };

function requiredText(raw: unknown, missing: string): TextResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: missing };
  if (text.length > MAX_DISPUTE_TEXT) {
    return { ok: false, error: `Keep it under ${MAX_DISPUTE_TEXT} characters.` };
  }
  return { ok: true, text };
}

/** Reads the annotator's reason for a dispute. */
export function parseDisputeReason(form: FormData): TextResult {
  return requiredText(form.get('reason'), 'Say why you think the decision is wrong.');
}

/** What a resolver can decide. A dispute can also end by being withdrawn. */
export type DisputeOutcome = 'UPHELD' | 'OVERTURNED';

const OUTCOMES: Record<string, DisputeOutcome> = { uphold: 'UPHELD', overturn: 'OVERTURNED' };

/** Reads the resolver's form: uphold or overturn, always with a note. */
export function parseResolution(
  form: FormData,
): { ok: true; outcome: DisputeOutcome; resolution: string } | { ok: false; error: string } {
  // own keys only: "constructor" and the like are on every object
  const intent = String(form.get('intent') ?? '');
  const outcome = Object.hasOwn(OUTCOMES, intent) ? OUTCOMES[intent] : undefined;
  if (!outcome) return { ok: false, error: 'Choose uphold or overturn.' };
  const note = requiredText(form.get('resolution'), 'Add a note that explains the outcome.');
  if (!note.ok) return note;
  return { ok: true, outcome, resolution: note.text };
}

type ShownDispute = { status: DisputeStatus; resolution: string | null };

/**
 * What a page that shows "the latest review" of a submission shows. Feedback
 * and score of a decision that was overturned are left out; the outcome of
 * the dispute stands in for them.
 */
export function shownReview(
  review:
    | {
        feedback: string;
        qaScore: number | null;
        overturnedAt: Date | null;
        dispute?: ShownDispute | null;
      }
    | undefined,
): { feedback: string; qaScore: number | null; dispute: ShownDispute | null } {
  const dispute = review?.dispute
    ? { status: review.dispute.status, resolution: review.dispute.resolution }
    : null;
  if (!review || review.overturnedAt) return { feedback: '', qaScore: null, dispute };
  return { feedback: review.feedback, qaScore: review.qaScore, dispute };
}
