import type { Prisma, PrismaClient, ReviewStatus } from '@prisma/client';

import { computePayouts, type PaidWork } from '~/domain/payouts';
import { prisma } from '~/lib/db.server';

type Db = PrismaClient | Prisma.TransactionClient;

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
  status: true,
  payRunId: true,
  activeSeconds: true,
  rateCents: true,
  payMode: true,
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
    released: row.status === 'RELEASED',
  };
}

/**
 * Accepted work that became payable within the range. The date is stored on
 * the assignment (`payableAt`) by the write that accepted the work: the
 * review that approved or fixed it, the submission when no review was needed,
 * the overturn of a send-back, or a manager's release of a claim on an
 * hourly project. Work that was accepted before the date was
 * stored carries its submission date, which is what the reports went by then.
 */
async function payableWork(db: Db, where: Prisma.AssignmentWhereInput, range: PayoutRange) {
  const rows = await db.assignment.findMany({
    where: {
      ...where,
      // a claim a manager released carries a payable date only when it was
      // credited time on an hourly project (`releaseClaim`)
      status: { in: ['SUBMITTED', 'RELEASED'] },
      payableAt: bounds(range),
    },
    select: WORK_SELECT,
  });
  return rows.map(toPaidWork);
}

/**
 * What the organisation owes for a period, grouped per annotator: accepted
 * work that became payable within the range (both days inclusive, UTC).
 * `pending` counts work submitted in the range that is waiting for review or
 * was sent back, which has no payable date yet.
 */
export async function payoutReport(
  orgId: string,
  range: PayoutRange,
  projectId?: string | null,
  db: Db = prisma,
) {
  const scope: Prisma.AssignmentWhereInput = {
    project: { orgId },
    ...(projectId ? { projectId } : {}),
  };
  const [work, pending] = await Promise.all([
    payableWork(db, scope, range),
    db.assignment.count({
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
    payableWork(prisma, scope, range),
    notPayable('PENDING'),
    notPayable('SENT_BACK'),
  ]);
  return {
    payable: ownBlocks(payable),
    waiting: ownBlocks(waiting.map(toPaidWork)),
    sentBack: ownBlocks(sentBack.map(toPaidWork)),
  };
}

/**
 * The person's payable work in the range split by whether a closed run paid
 * it: the unpaid blocks, and the blocks of each run that paid some of it,
 * with the run's date.
 */
export async function paidSplit(orgId: string, userId: string, range: PayoutRange) {
  const rows = await prisma.assignment.findMany({
    where: {
      project: { orgId },
      userId,
      status: { in: ['SUBMITTED', 'RELEASED'] },
      payableAt: bounds(range),
    },
    select: WORK_SELECT,
  });
  const byRun = new Map<string | null, WorkRow[]>();
  for (const row of rows) byRun.set(row.payRunId, [...(byRun.get(row.payRunId) ?? []), row]);
  const runIds = [...byRun.keys()].filter((id): id is string => id !== null);
  const runs = await prisma.payRun.findMany({
    where: { id: { in: runIds } },
    orderBy: { periodStart: 'asc' },
    select: { id: true, closedAt: true },
  });
  return {
    unpaid: ownBlocks((byRun.get(null) ?? []).map(toPaidWork)),
    paid: runs.map((run) => ({
      runId: run.id,
      closedAt: run.closedAt,
      ...ownBlocks((byRun.get(run.id) ?? []).map(toPaidWork)),
    })),
  };
}
