import { describe, expect, it } from 'vitest';

import {
  annotatorDisputeState,
  disputeDeadline,
  disputeRefusal,
  parseDisputeReason,
  parseResolution,
  resolverRefusal,
  shownReview,
  type DisputableInput,
} from '~/domain/disputes';

const decidedAt = new Date('2026-04-01T12:00:00Z');
const daysLater = (days: number) => new Date(decidedAt.getTime() + days * 24 * 60 * 60_000);

const sentBack: DisputableInput = {
  reviewStatus: 'SENT_BACK',
  review: {
    decision: 'SEND_BACK',
    reviewerId: 'reviewer',
    createdAt: decidedAt,
    overturnedAt: null,
    disputed: false,
  },
  openerId: 'annotator',
  windowDays: 14,
  resolvers: 1,
};
const withReview = (review: Partial<NonNullable<DisputableInput['review']>>): DisputableInput => ({
  ...sentBack,
  review: { ...sentBack.review!, ...review },
});

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

describe('disputeRefusal', () => {
  it('allows sent-back and fixed work inside the window', () => {
    expect(disputeRefusal(sentBack, daysLater(1))).toBeNull();
    const fixed = { ...withReview({ decision: 'FIX' }), reviewStatus: 'FIXED' as const };
    expect(disputeRefusal(fixed, daysLater(1))).toBeNull();
  });

  it('only takes work whose current state rests on the decision', () => {
    for (const reviewStatus of ['APPROVED', 'PENDING', 'NOT_REQUIRED', null] as const) {
      expect(disputeRefusal({ ...sentBack, reviewStatus }, daysLater(1))).toBe('not_disputable');
    }
    expect(disputeRefusal({ ...sentBack, review: null }, daysLater(1))).toBe('not_disputable');
    // sent back, revised and still waiting: the latest decision is not this state's
    expect(disputeRefusal(withReview({ decision: 'APPROVE' }), daysLater(1))).toBe(
      'not_disputable',
    );
    expect(disputeRefusal(withReview({ overturnedAt: daysLater(2) }), daysLater(3))).toBe(
      'not_disputable',
    );
  });

  it('takes one dispute per decision and none on your own decision', () => {
    expect(disputeRefusal(withReview({ disputed: true }), daysLater(1))).toBe('already_disputed');
    expect(disputeRefusal({ ...sentBack, openerId: 'reviewer' }, daysLater(1))).toBe(
      'own_decision',
    );
  });

  it('closes when the project window is over, and stays shut at zero days', () => {
    expect(disputeDeadline(decidedAt, 14)).toEqual(daysLater(14));
    expect(disputeRefusal(sentBack, daysLater(14))).toBeNull();
    expect(disputeRefusal(sentBack, new Date(daysLater(14).getTime() + 1))).toBe('too_late');
    expect(disputeRefusal({ ...sentBack, windowDays: 3 }, daysLater(4))).toBe('too_late');

    expect(disputeDeadline(decidedAt, 0)).toBeNull();
    expect(disputeRefusal({ ...sentBack, windowDays: 0 }, decidedAt)).toBe('disabled');
  });
});

describe('a dispute nobody could settle', () => {
  it('is refused, after every other reason', () => {
    const alone = { ...sentBack, resolvers: 0 };
    expect(disputeRefusal(alone, daysLater(1))).toBe('no_resolver');
    expect(disputeRefusal(alone, daysLater(15))).toBe('too_late');
    expect(disputeRefusal({ ...alone, windowDays: 0 }, daysLater(1))).toBe('disabled');
  });

  it('is explained on the page instead of offered', () => {
    const state = annotatorDisputeState(
      {
        reviewStatus: 'SENT_BACK',
        annotatorId: 'annotator',
        review: { ...sentBack.review!, dispute: null },
        windowDays: 14,
        resolvers: 0,
      },
      daysLater(1),
    );
    expect(state.disputeUntil).toBeNull();
    expect(state.disputeClosed).toMatch(/Nobody could settle a dispute/);
  });
});

describe('annotatorDisputeState', () => {
  const submission = {
    reviewStatus: 'SENT_BACK' as const,
    annotatorId: 'annotator',
    review: { ...sentBack.review!, dispute: null },
    windowDays: 14,
    resolvers: 1,
  };

  it('offers a dispute until the deadline and says so once it has passed', () => {
    expect(annotatorDisputeState(submission, daysLater(1))).toEqual({
      dispute: null,
      disputeUntil: daysLater(14),
      disputeClosed: null,
    });
    expect(annotatorDisputeState(submission, daysLater(15))).toEqual({
      dispute: null,
      disputeUntil: null,
      disputeClosed: 'The time to dispute this decision has passed.',
    });
    expect(annotatorDisputeState({ ...submission, windowDays: 0 }, daysLater(1))).toEqual({
      dispute: null,
      disputeUntil: null,
      disputeClosed: null,
    });
  });

  it('shows the dispute that was opened and offers no second one', () => {
    const dispute = {
      status: 'UPHELD' as const,
      reason: 'I was right',
      resolution: 'Stands',
      createdAt: daysLater(1),
      resolvedAt: daysLater(2),
      resolvedBy: { name: 'Sam' },
    };
    const state = annotatorDisputeState(
      { ...submission, review: { ...submission.review, dispute } },
      daysLater(3),
    );
    expect(state).toEqual({
      dispute: {
        status: 'UPHELD',
        reason: 'I was right',
        resolution: 'Stands',
        resolver: 'Sam',
        openedAt: daysLater(1),
        resolvedAt: daysLater(2),
      },
      disputeUntil: null,
      disputeClosed: null,
    });
  });
});

describe('resolverRefusal', () => {
  const dispute = { reviewerId: 'reviewer', annotatorId: 'annotator' };

  it('keeps out the reviewer who decided and the annotator who did the work', () => {
    expect(resolverRefusal({ ...dispute, resolverId: 'reviewer' })).toBe('own_decision');
    expect(resolverRefusal({ ...dispute, resolverId: 'annotator' })).toBe('own_work');
    expect(resolverRefusal({ ...dispute, resolverId: 'someone-else' })).toBeNull();
  });
});

describe('dispute forms', () => {
  it('needs a reason', () => {
    expect(parseDisputeReason(form({ reason: '  ' })).ok).toBe(false);
    expect(parseDisputeReason(form({ reason: 'x'.repeat(2001) })).ok).toBe(false);
    expect(parseDisputeReason(form({ reason: ' The label is right. ' }))).toEqual({
      ok: true,
      text: 'The label is right.',
    });
  });

  it('needs an outcome and a note to settle', () => {
    expect(parseResolution(form({ intent: 'overturn', resolution: 'Annotator is right' }))).toEqual(
      { ok: true, outcome: 'OVERTURNED', resolution: 'Annotator is right' },
    );
    expect(parseResolution(form({ intent: 'uphold', resolution: 'Stands' }))).toMatchObject({
      outcome: 'UPHELD',
    });
    expect(parseResolution(form({ intent: 'uphold', resolution: '' })).ok).toBe(false);
    expect(parseResolution(form({ intent: 'reopen', resolution: 'x' })).ok).toBe(false);
    // names every object has are not outcomes
    for (const intent of ['constructor', 'toString', '__proto__', 'withdraw']) {
      expect(parseResolution(form({ intent, resolution: 'x' }))).toEqual({
        ok: false,
        error: 'Choose uphold or overturn.',
      });
    }
  });
});

describe('shownReview', () => {
  const review = { feedback: 'Wrong label', qaScore: 2, overturnedAt: null };

  it('shows the latest review as it is', () => {
    expect(shownReview(review)).toEqual({ feedback: 'Wrong label', qaScore: 2, dispute: null });
    expect(shownReview(undefined)).toEqual({ feedback: '', qaScore: null, dispute: null });
  });

  it('keeps the feedback of a decision that was upheld', () => {
    const upheld = { ...review, dispute: { status: 'UPHELD' as const, resolution: 'Stands' } };
    expect(shownReview(upheld)).toEqual({
      feedback: 'Wrong label',
      qaScore: 2,
      dispute: { status: 'UPHELD', resolution: 'Stands' },
    });
  });

  it('shows the outcome of the dispute instead of an overturned decision', () => {
    const overturned = {
      ...review,
      overturnedAt: daysLater(2),
      dispute: { status: 'OVERTURNED' as const, resolution: 'The label was right' },
    };
    expect(shownReview(overturned)).toEqual({
      feedback: '',
      qaScore: null,
      dispute: { status: 'OVERTURNED', resolution: 'The label was right' },
    });
  });
});
