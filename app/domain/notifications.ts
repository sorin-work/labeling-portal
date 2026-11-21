/**
 * Notifications inside the app: what each kind says. The app sends no mail;
 * a person sees these on `/notifications` and as a count in the header.
 *
 * A notification never holds an answer or a reason someone wrote, only what
 * the sentence needs: a task number, an outcome, two scores. A gold rescore
 * says that the task was gold, so it is only written where the project's
 * gold feedback already tells the annotator that after they submit.
 */

export const NOTIFICATION_KINDS = {
  'review.sent_back': 'Work sent back',
  'review.fixed': 'Work corrected',
  'dispute.opened': 'Dispute opened',
  'dispute.resolved': 'Dispute settled',
  'gold.rescored': 'Gold score changed',
  'claim.released': 'Claim released',
  'project.instructions': 'Instructions changed',
} as const;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/** Read notifications older than this are removed when the page is opened. */
export const NOTIFICATION_RETENTION_DAYS = 90;

/** How many the page shows at a time. */
export const NOTIFICATIONS_SHOWN = 50;

type Detail = Record<string, unknown>;

function percent(value: unknown): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'none';
}

/** A notification as one sentence. A kind this does not know reads as its name. */
export function describeNotification(kind: string, detail: unknown): string {
  const d: Detail = typeof detail === 'object' && detail !== null ? (detail as Detail) : {};
  const project = typeof d.projectName === 'string' ? `“${d.projectName}”` : 'a project';
  const task = typeof d.position === 'number' ? `task #${d.position}` : 'a task';
  const who = typeof d.actorName === 'string' ? d.actorName : 'Someone';
  switch (kind as NotificationKind) {
    case 'review.sent_back':
      return `${who} sent back your work on ${task} in ${project}. It needs changes.`;
    case 'review.fixed':
      return `${who} corrected your work on ${task} in ${project}.`;
    case 'dispute.opened':
      return `${who} disputed a review decision on ${task} in ${project}.`;
    case 'dispute.resolved': {
      const outcome = d.outcome === 'OVERTURNED' ? 'overturned' : 'upheld';
      return d.role === 'reviewer'
        ? `${who} ${outcome} your decision on ${task} in ${project} after a dispute.`
        : `${who} ${outcome} the decision you disputed on ${task} in ${project}.`;
    }
    case 'gold.rescored':
      return `Your score on a gold task in ${project} changed from ${percent(d.from)} to ${percent(d.to)} after its expected answer was corrected.`;
    case 'claim.released':
      return `${who} released your claim on ${task} in ${project}. Your draft is gone and the task went back to the queue.`;
    case 'project.instructions':
      return `${who} changed the instructions of ${project}.`;
    default:
      return kind;
  }
}
