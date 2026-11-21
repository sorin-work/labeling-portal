import type { PayMode } from './payouts';

/** "2 hours 5 minutes", "45 minutes", "less than a minute". */
export function spokenDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'less than a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/**
 * What a manager is asked before releasing someone's claim on the task page:
 * how long the claim has run, whether a draft is lost, and whether the time
 * the draft recorded is paid (`releaseClaim` credits it on hourly projects).
 */
export function releaseConfirmation(input: {
  annotator: string;
  claimedAt: Date;
  now: Date;
  hasDraft: boolean;
  draftSeconds: number;
  payMode: PayMode;
}): string {
  const { annotator, hasDraft, draftSeconds, payMode } = input;
  const ran = spokenDuration((input.now.getTime() - input.claimedAt.getTime()) / 1000);
  const parts = [
    `${annotator} claimed this task ${ran} ago.`,
    hasDraft
      ? `Their draft is thrown away and the task goes back to the queue.`
      : `They saved no draft. The task goes back to the queue.`,
  ];
  if (draftSeconds > 0) {
    parts.push(
      payMode === 'HOURLY'
        ? `Their draft saves recorded ${spokenDuration(draftSeconds)} of work, which is credited to them as on a submission.`
        : `Their draft saves recorded ${spokenDuration(draftSeconds)} of work. This project pays per accepted task, so that time is not paid.`,
    );
  }
  parts.push('Release the claim?');
  return parts.join(' ');
}
