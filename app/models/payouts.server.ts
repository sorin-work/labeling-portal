import type { Prisma, ReviewStatus } from '@prisma/client';

import { ACCEPTED_STATUSES } from '~/domain/outcome';
import { computePayouts, payableAt, type PaidWork } from '~/domain/payouts';
import { prisma } from '~/lib/db.server';

export type PayoutRange = { from: string; to: string };

/** The range as instants: both days count in full, in UTC. */
function bounds(range: PayoutRange): { gte: Date; lt: Date } {
  const gte = new Date(`${range.from}T00:00:00Z`);
  // the last day counts in full: stop at midnight after it
  const lt = new Date(`${range.to}T00:00:00Z`);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte, lt };
}

const WORK_SELECT = {
  activeSeconds: true,
  rateCents: true,
  payMode: true,
  reviewStatus: true,
  submittedAt: true,
  reviewedAt: true,
  user: { select: { id: true, name: true, email: true } },
  project: { select: { id: true, name: true } },
} satisfies Prisma.AssignmentSelect;

type WorkRow = Prisma.AssignmentGetPayload<{ select: typeof WORK_SELECT }>;

/**
 * A submission as the pay code sees it, priced with the rate and pay mode
 * that were frozen on it at submission. The project's current rate is never
 * read here, so changing it does not reprice work that is already in.
 */
function toPaidWork(row: WorkRow): PaidWork {
  if (row.rateCents === null || row.payMode === null) {
    // the database refuses a submission without them (Assignment_submitted_has_rate)
    throw new Error('A submitted assignment has no frozen rate');
  }
  return {
    userId: row.user.id,
    name: row.user.name,
    email: row.user.email,
    projectId: row.project.id,
    projectName: row.project.name,
    payMode: row.payMode,
    rateCents: row.rateCents,
    activeSeconds: row.activeSeconds,
  };
}

/**
 * Accepted work that became payable within the range. The date that counts
 * is `payableAt`: the review for work a reviewer approved or fixed, the
 * submission for work that needed no review. The query fetches everything
 * submitted or reviewed in the range and `payableAt` decides, so the rule
 * lives in one place.
 */
async function payableWork(where: Prisma.AssignmentWhereInput, range: PayoutRange) {
  const { gte, lt } = bounds(range);
  const rows = await prisma.assignment.findMany({
    where: {
      ...where,
      status: 'SUBMITTED',
      reviewStatus: { in: [...ACCEPTED_STATUSES] },
      OR: [{ submittedAt: { gte, lt } }, { reviewedAt: { gte, lt } }],
    },
    select: WORK_SELECT,
  });
  return rows
    .filter((row) => {
      const payable = payableAt(row);
      return payable !== null && payable >= gte && payable < lt;
    })
    .map(toPaidWork);
}

/**
 * What the organisation owes for a period, grouped per annotator: accepted
 * work that became payable within the range (both days inclusive, UTC).
 * `pending` counts work submitted in the range that is waiting for review or
 * was sent back, which has no payable date yet.
 */
export async function payoutReport(orgId: string, range: PayoutRange, projectId?: string | null) {
  const scope: Prisma.AssignmentWhereInput = {
    project: { orgId },
    ...(projectId ? { projectId } : {}),
  };
  const [work, pending] = await Promise.all([
    payableWork(scope, range),
    prisma.assignment.count({
      where: {
        ...scope,
        status: 'SUBMITTED',
        reviewStatus: { in: ['PENDING', 'SENT_BACK'] },
        submittedAt: bounds(range),
      },
    }),
  ]);
  return { ...computePayouts(work), pending };
}

/** Blocks of one person's work with their total, as the earnings page shows them. */
function ownBlocks(work: PaidWork[]) {
  const { lines, totalCents } = computePayouts(work);
  return {
    blocks: lines.flatMap((line) => line.projects),
    tasks: lines.reduce((sum, line) => sum + line.tasks, 0),
    seconds: lines.reduce((sum, line) => sum + line.seconds, 0),
    totalCents,
  };
}

/**
 * One person's own money in an organisation: what became payable within the
 * range, computed exactly as their line of `payoutReport`, and everything
 * that is not payable yet, whatever the range, because it has no payable date
 * to put it in a period. Those amounts are what the work earns if it is
 * accepted.
 */
export async function earningsReport(orgId: string, userId: string, range: PayoutRange) {
  const scope: Prisma.AssignmentWhereInput = { project: { orgId }, userId };
  const notPayable = (reviewStatus: ReviewStatus) =>
    prisma.assignment.findMany({
      where: { ...scope, status: 'SUBMITTED', reviewStatus },
      select: WORK_SELECT,
    });
  const [payable, waiting, sentBack] = await Promise.all([
    payableWork(scope, range),
    notPayable('PENDING'),
    notPayable('SENT_BACK'),
  ]);
  return {
    payable: ownBlocks(payable),
    waiting: ownBlocks(waiting.map(toPaidWork)),
    sentBack: ownBlocks(sentBack.map(toPaidWork)),
  };
}
