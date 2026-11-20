import type { DisputeStatus } from '@prisma/client';
import { Form } from 'react-router';

import { MAX_DISPUTE_TEXT } from '~/domain/disputes';
import { DISPUTE_BADGES, formatDateTime } from '~/lib/format';

import { Badge, Button } from './ui';

export type DisputeView = {
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  resolver: string | null;
  openedAt: Date | string;
  resolvedAt: Date | string | null;
};

/**
 * The annotator's side of a dispute on their own work: the state of the one
 * they opened, or the form to open one while the project's window allows it.
 */
export function DisputePanel({
  dispute,
  until,
  closed,
  busy,
}: {
  dispute: DisputeView | null;
  /** the deadline for opening a dispute, when one can still be opened */
  until: Date | string | null;
  /** why no dispute can be opened, when that is worth saying */
  closed: string | null;
  busy: boolean;
}) {
  if (dispute) {
    const badge = DISPUTE_BADGES[dispute.status];
    return (
      <div className="space-y-2 rounded-md bg-white px-4 py-3 text-sm ring-1 ring-slate-200">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span className="text-slate-500">
            {dispute.status === 'OPEN'
              ? `You disputed this decision on ${formatDateTime(dispute.openedAt)}. Someone other than the reviewer will look at it.`
              : `${dispute.status === 'WITHDRAWN' ? 'You withdrew it' : 'Settled'}${
                  dispute.resolver ? ` by ${dispute.resolver}` : ''
                }${dispute.resolvedAt ? ` on ${formatDateTime(dispute.resolvedAt)}` : ''}.`}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-slate-600">
          <span className="font-medium">Your reason:</span> {dispute.reason}
        </p>
        {dispute.resolution && (
          <p className="whitespace-pre-wrap text-slate-600">
            <span className="font-medium">Outcome:</span> {dispute.resolution}
          </p>
        )}
        {dispute.status === 'OPEN' && (
          <Form method="post" className="flex flex-wrap items-center gap-3">
            <Button name="intent" value="withdraw-dispute" variant="ghost" disabled={busy}>
              Withdraw the dispute
            </Button>
            <span className="text-xs text-slate-500">
              The decision then stands and the work is where it was before. You cannot dispute this
              decision again.
            </span>
          </Form>
        )}
      </div>
    );
  }
  if (!until) return closed ? <p className="text-sm text-slate-500">{closed}</p> : null;
  return (
    <details className="rounded-md bg-white px-4 py-3 text-sm ring-1 ring-slate-200">
      <summary className="cursor-pointer font-medium">I think my answer was right</summary>
      <Form method="post" className="mt-3 space-y-2">
        <p className="text-slate-600">
          Dispute the decision and someone other than the reviewer looks at it again. You can do
          this once, until {formatDateTime(until)}. While a dispute is open the work cannot be
          revised.
        </p>
        <label className="block font-medium">
          Why the decision is wrong
          <textarea
            name="reason"
            rows={3}
            required
            maxLength={MAX_DISPUTE_TEXT}
            className="mt-1 block w-full rounded-md px-3 py-2 font-normal ring-1 ring-slate-300"
          />
        </label>
        <Button name="intent" value="dispute" variant="secondary" disabled={busy}>
          Dispute this decision
        </Button>
      </Form>
    </details>
  );
}
