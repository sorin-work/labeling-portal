/**
 * Closing a pay period as paid. A closed period is a `PayRun`: the payout
 * report of that moment, copied, and the work in it marked so that no work is
 * paid twice. Runs are never reopened; see docs/architecture.md, "Pay runs".
 */

export type PeriodBounds = { start: Date; end: Date };

export type CloseRefusal = 'not_over' | 'overlap' | 'order';

/** A period as instants: from midnight UTC of the first day to midnight after the last. */
export function periodBounds(range: { from: string; to: string }): PeriodBounds {
  const start = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/**
 * Why a period cannot be closed now, or null when it can. Work becomes
 * payable at the moment it is accepted, so a period that has not ended in
 * UTC could still gain work after the close: only a period whose last day is
 * over can be closed. Two runs never cover the same day.
 */
export function closeRefusal(
  period: PeriodBounds,
  now: Date,
  runs: readonly PeriodBounds[],
): CloseRefusal | null {
  if (period.end <= period.start) return 'order';
  if (period.end > now) return 'not_over';
  if (runs.some((run) => run.start < period.end && period.start < run.end)) return 'overlap';
  return null;
}

export const CLOSE_REFUSALS: Record<CloseRefusal, string> = {
  order: 'The period ends before it starts.',
  not_over:
    'Only a period that is over can be closed: work accepted today could still fall into it. Close it tomorrow.',
  overlap: 'A closed run already covers part of this period. Each day is paid in one run only.',
};
