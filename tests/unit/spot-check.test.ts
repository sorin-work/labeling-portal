import { describe, expect, it } from 'vitest';

import { parseSpotCheckForm, spotCheckRefusal } from '~/domain/spot-check';

const unseen = {
  status: 'SUBMITTED',
  reviewStatus: 'NOT_REQUIRED',
  isGold: false,
  isQualification: false,
  reviews: 0,
  ownWork: false,
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe('spotCheckRefusal', () => {
  it('allows accepted work that no reviewer has seen', () => {
    expect(spotCheckRefusal(unseen)).toBeNull();
  });

  it('refuses reviewed, pending, sent-back and already checked work', () => {
    for (const reviewStatus of ['APPROVED', 'FIXED', 'PENDING', 'SENT_BACK', null]) {
      expect(spotCheckRefusal({ ...unseen, reviewStatus })).toBe('not_unseen');
    }
    expect(spotCheckRefusal({ ...unseen, reviews: 1 })).toBe('not_unseen');
    expect(spotCheckRefusal({ ...unseen, status: 'SKIPPED' })).toBe('not_unseen');
  });

  it('refuses gold, qualification tasks and own work', () => {
    expect(spotCheckRefusal({ ...unseen, isGold: true })).toBe('gold');
    expect(spotCheckRefusal({ ...unseen, isQualification: true })).toBe('gold');
    expect(spotCheckRefusal({ ...unseen, ownWork: true })).toBe('own_work');
  });
});

describe('parseSpotCheckForm', () => {
  it('reads the verdict, the score and the feedback', () => {
    expect(parseSpotCheckForm(form({ intent: 'spot_fine', qaScore: '4' }))).toEqual({
      ok: true,
      value: { verdict: 'APPROVE', qaScore: 4, feedback: '' },
    });
    expect(
      parseSpotCheckForm(form({ intent: 'spot_send_back', qaScore: '2', feedback: ' Wrong. ' })),
    ).toEqual({ ok: true, value: { verdict: 'SEND_BACK', qaScore: 2, feedback: 'Wrong.' } });
  });

  it('needs a score from 1 to 5, a known verdict and feedback for a send-back', () => {
    expect(parseSpotCheckForm(form({ intent: 'spot_fine' })).ok).toBe(false);
    expect(parseSpotCheckForm(form({ intent: 'spot_fine', qaScore: '6' })).ok).toBe(false);
    expect(parseSpotCheckForm(form({ intent: 'approve', qaScore: '3' })).ok).toBe(false);
    expect(parseSpotCheckForm(form({ intent: 'spot_send_back', qaScore: '3' })).ok).toBe(false);
  });
});
