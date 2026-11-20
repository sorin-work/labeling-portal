import { describe, expect, it } from 'vitest';

import { finalAnswer, isAccepted, standingReviews } from '~/domain/outcome';

describe('isAccepted', () => {
  it('accepts approved, fixed and unreviewed-by-design work', () => {
    expect(isAccepted('APPROVED')).toBe(true);
    expect(isAccepted('FIXED')).toBe(true);
    expect(isAccepted('NOT_REQUIRED')).toBe(true);
  });

  it('does not accept pending or returned work', () => {
    expect(isAccepted('PENDING')).toBe(false);
    expect(isAccepted('SENT_BACK')).toBe(false);
    expect(isAccepted(null)).toBe(false);
  });
});

describe('finalAnswer', () => {
  it('prefers the latest correction', () => {
    const reviews = [
      { decision: 'FIX', correctedAnswer: { labels: ['a'] }, createdAt: '2026-01-01T10:00:00Z' },
      { decision: 'FIX', correctedAnswer: { labels: ['b'] }, createdAt: '2026-01-02T10:00:00Z' },
      { decision: 'APPROVE', correctedAnswer: null, createdAt: '2026-01-03T10:00:00Z' },
    ];
    expect(finalAnswer({ labels: ['x'] }, reviews)).toEqual({ labels: ['b'] });
  });

  it("falls back to the annotator's answer", () => {
    expect(finalAnswer({ labels: ['x'] }, [])).toEqual({ labels: ['x'] });
  });

  it('skips a correction that a dispute overturned', () => {
    const overturned = {
      decision: 'FIX',
      correctedAnswer: { labels: ['b'] },
      createdAt: '2026-01-02T10:00:00Z',
      overturnedAt: '2026-01-05T10:00:00Z',
    };
    expect(finalAnswer({ labels: ['x'] }, [overturned])).toEqual({ labels: ['x'] });

    const earlier = {
      decision: 'FIX',
      correctedAnswer: { labels: ['a'] },
      createdAt: '2026-01-01T10:00:00Z',
      overturnedAt: null,
    };
    expect(finalAnswer({ labels: ['x'] }, [earlier, overturned])).toEqual({ labels: ['a'] });
  });
});

describe('standingReviews', () => {
  it('leaves out overturned decisions', () => {
    const reviews = [
      { id: 'kept', overturnedAt: null },
      { id: 'gone', overturnedAt: new Date('2026-01-05T10:00:00Z') },
      { id: 'old row without the column' },
    ];
    expect(standingReviews(reviews).map((r) => r.id)).toEqual([
      'kept',
      'old row without the column',
    ]);
  });
});
