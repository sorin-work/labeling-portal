/**
 * Taking back the last submission: for a short while after "Submit and
 * next", the annotator can turn what they just handed in into work they
 * revise, the same state as work a reviewer sent back, with a marker that
 * they asked for it (`Assignment.takenBackAt`). It is allowed only while
 * nothing downstream has read the submission.
 */

/** How long after handing in a submission it can be taken back. */
export const TAKE_BACK_MINUTES = 2;

export type TakeBackRefusal =
  | 'not_submitted'
  | 'too_late'
  | 'reviewed'
  | 'held'
  | 'complete'
  | 'gold_seen'
  | 'taken_back'
  | 'not_last';

export type TakeBackState = {
  status: string;
  reviewStatus: string | null;
  submittedAt: Date | null;
  /** a review row of any kind exists, spot checks included */
  reviewed: boolean;
  /** a reviewer has a live hold on it */
  held: boolean;
  /** the status of its task */
  taskStatus: string;
  /**
   * the task's agreement was measured on its accepted answers already (it got
   * extra slots or has a stored agreement)
   */
  agreementChecked: boolean;
  isGold: boolean;
  /** the project shows the expected answer after a gold task is handed in */
  goldFeedback: boolean;
  takenBackAt: Date | null;
  /** it is the annotator's most recent submission in the project */
  latest: boolean;
};

/** The moment a submission handed in at `submittedAt` can no longer be taken back. */
export function takeBackUntil(submittedAt: Date): Date {
  return new Date(submittedAt.getTime() + TAKE_BACK_MINUTES * 60_000);
}

/**
 * Why the submission cannot be taken back now, or null when it can.
 *
 * - It must be the annotator's last submission in the project, handed in
 *   less than `TAKE_BACK_MINUTES` ago, and taken back only once: a
 *   taken-back submission handed in again is not offered again, or the
 *   window could be stretched for ever.
 * - Waiting for review (`PENDING`), not held by a reviewer and never
 *   reviewed; or accepted without review (`NOT_REQUIRED`) on a task that is
 *   still open and whose agreement was not measured yet (no extra slots, no
 *   stored agreement), so no consensus or agreement was built from it.
 * - Gold: with gold feedback on the annotator has seen the expected answer,
 *   so it must not be taken back. With feedback off, refusing it would tell
 *   gold apart from other work, so it is offered like any other task and
 *   scored again when it is handed in again.
 */
export function takeBackRefusal(state: TakeBackState, now: Date): TakeBackRefusal | null {
  if (state.status !== 'SUBMITTED' || !state.submittedAt) return 'not_submitted';
  if (state.takenBackAt) return 'taken_back';
  if (!state.latest) return 'not_last';
  if (now >= takeBackUntil(state.submittedAt)) return 'too_late';
  if (state.isGold && state.goldFeedback) return 'gold_seen';
  if (state.reviewed) return 'reviewed';
  if (state.reviewStatus === 'PENDING') return state.held ? 'held' : null;
  if (state.reviewStatus === 'NOT_REQUIRED') {
    // accepted answers that were measured for agreement have been read
    if (state.taskStatus !== 'OPEN' || state.agreementChecked) return 'complete';
    return null;
  }
  return 'reviewed';
}
