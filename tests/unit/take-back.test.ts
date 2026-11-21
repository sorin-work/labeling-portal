import { describe, expect, it } from 'vitest';

import { takeBackRefusal, takeBackUntil, type TakeBackState } from '~/domain/take-back';

const submittedAt = new Date('2026-03-02T10:00:00Z');
const now = new Date('2026-03-02T10:01:00Z');

const pending: TakeBackState = {
  status: 'SUBMITTED',
  reviewStatus: 'PENDING',
  submittedAt,
  reviewed: false,
  held: false,
  taskStatus: 'OPEN',
  agreementChecked: false,
  isGold: false,
  goldFeedback: true,
  takenBackAt: null,
  latest: true,
};

describe('takeBackRefusal', () => {
  it('allows work waiting for review that nobody holds', () => {
    expect(takeBackRefusal(pending, now)).toBeNull();
  });

  it('allows work accepted without review while its task is open', () => {
    const accepted = { ...pending, reviewStatus: 'NOT_REQUIRED' };
    expect(takeBackRefusal(accepted, now)).toBeNull();
    expect(takeBackRefusal({ ...accepted, taskStatus: 'COMPLETE' }, now)).toBe('complete');
    expect(takeBackRefusal({ ...accepted, taskStatus: 'ADJUDICATION' }, now)).toBe('complete');
    // the task got extra slots: its accepted answers were measured already
    expect(takeBackRefusal({ ...accepted, agreementChecked: true }, now)).toBe('complete');
    // work waiting for review was not among the measured answers
    expect(takeBackRefusal({ ...pending, agreementChecked: true }, now)).toBeNull();
  });

  it('refuses after two minutes, exactly at the edge', () => {
    expect(takeBackUntil(submittedAt).toISOString()).toBe('2026-03-02T10:02:00.000Z');
    expect(takeBackRefusal(pending, new Date('2026-03-02T10:01:59Z'))).toBeNull();
    expect(takeBackRefusal(pending, new Date('2026-03-02T10:02:00Z'))).toBe('too_late');
  });

  it('refuses work a reviewer holds, has decided or spot checked', () => {
    expect(takeBackRefusal({ ...pending, held: true }, now)).toBe('held');
    expect(takeBackRefusal({ ...pending, reviewed: true }, now)).toBe('reviewed');
    for (const reviewStatus of ['APPROVED', 'FIXED', 'SENT_BACK', null]) {
      expect(takeBackRefusal({ ...pending, reviewStatus }, now)).toBe('reviewed');
    }
  });

  it('refuses what is not a submission, not the last one, or was taken back already', () => {
    expect(takeBackRefusal({ ...pending, status: 'SKIPPED' }, now)).toBe('not_submitted');
    expect(takeBackRefusal({ ...pending, submittedAt: null }, now)).toBe('not_submitted');
    expect(takeBackRefusal({ ...pending, latest: false }, now)).toBe('not_last');
    expect(takeBackRefusal({ ...pending, takenBackAt: submittedAt }, now)).toBe('taken_back');
  });

  it('refuses gold whose answer the annotator has seen, and offers it otherwise', () => {
    const gold = { ...pending, reviewStatus: 'NOT_REQUIRED', isGold: true };
    expect(takeBackRefusal(gold, now)).toBe('gold_seen');
    expect(takeBackRefusal({ ...gold, goldFeedback: false }, now)).toBeNull();
    // feedback off and the take-back offered: a gold task looks like any other
    expect(takeBackRefusal({ ...pending, goldFeedback: false }, now)).toBeNull();
  });
});
