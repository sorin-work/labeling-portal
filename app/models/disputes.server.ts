import { Prisma, type Dispute } from '@prisma/client';

import {
  disputeRefusal,
  resolverRefusal,
  type DisputeOutcome,
  type DisputeRefusal,
  type ResolverRefusal,
} from '~/domain/disputes';
import { prisma } from '~/lib/db.server';

import { refreshTaskStatus } from './tasks.server';

/**
 * Locks a submission until the transaction ends. Opening a dispute and
 * revising sent-back work exclude each other, and both start here: whichever
 * comes second waits, and then sees what the first one did.
 */
async function lockSubmission(tx: Prisma.TransactionClient, assignmentId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Assignment" WHERE id = ${assignmentId} FOR UPDATE`;
  return rows.length > 0;
}

/** True while a dispute on the submission is waiting for an outcome. Locks the submission. */
export async function blockedByDispute(tx: Prisma.TransactionClient, assignmentId: string) {
  await lockSubmission(tx, assignmentId);
  const open = await tx.dispute.count({ where: { assignmentId, status: 'OPEN' } });
  return open > 0;
}

/** The latest decision on a submission, with what a dispute needs to know about it. */
const latestReview = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: { dispute: { select: { id: true } } },
} satisfies Prisma.Assignment$reviewsArgs;

/**
 * Opens a dispute on the latest decision on the annotator's own submission.
 * Every rule is checked here, under a lock on the submission, whatever the
 * page showed.
 */
export async function openDispute(
  assignmentId: string,
  openerId: string,
  reason: string,
  now = new Date(),
): Promise<{ ok: true; dispute: Dispute } | { ok: false; error: DisputeRefusal | 'not_found' }> {
  return prisma.$transaction(async (tx) => {
    await lockSubmission(tx, assignmentId);
    const assignment = await tx.assignment.findFirst({
      where: { id: assignmentId, userId: openerId, status: 'SUBMITTED' },
      include: { project: { select: { disputeWindowDays: true } }, reviews: latestReview },
    });
    if (!assignment) return { ok: false, error: 'not_found' };

    const review = assignment.reviews.at(0) ?? null;
    const refusal = disputeRefusal(
      {
        reviewStatus: assignment.reviewStatus,
        review: review && { ...review, disputed: review.dispute !== null },
        openerId,
        windowDays: assignment.project.disputeWindowDays,
      },
      now,
    );
    if (refusal || !review) return { ok: false, error: refusal ?? 'not_disputable' };

    const dispute = await tx.dispute.create({
      data: {
        assignmentId,
        reviewId: review.id,
        openedById: openerId,
        reason,
        // kept with the dispute: the submission can be revised after an upheld one
        answer: assignment.answer ?? Prisma.JsonNull,
        createdAt: now,
      },
    });
    return { ok: true, dispute };
  });
}

export type ResolveRefusal = ResolverRefusal | 'not_found' | 'already_resolved';

/**
 * Settles a dispute. Upholding only records the outcome. Overturning also
 * takes the decision back: the review is stamped as overturned, the
 * submission counts as approved and its task is refreshed. All of it is one
 * transaction, and each write is conditional on the state it expects, so two
 * resolvers cannot both settle a dispute and an overturn is never half done.
 */
export async function resolveDispute(
  disputeId: string,
  resolverId: string,
  input: { outcome: DisputeOutcome; resolution: string },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: ResolveRefusal }> {
  return prisma.$transaction(async (tx) => {
    const dispute = await tx.dispute.findUnique({
      where: { id: disputeId },
      include: {
        review: { select: { decision: true, reviewerId: true } },
        assignment: { select: { userId: true, taskId: true } },
      },
    });
    if (!dispute) return { ok: false, error: 'not_found' };
    const barred = resolverRefusal({
      resolverId,
      reviewerId: dispute.review.reviewerId,
      annotatorId: dispute.assignment.userId,
    });
    if (barred) return { ok: false, error: barred };

    const settled = await tx.dispute.updateMany({
      where: { id: disputeId, status: 'OPEN' },
      data: {
        status: input.outcome,
        resolvedById: resolverId,
        resolution: input.resolution,
        resolvedAt: now,
      },
    });
    if (settled.count === 0) return { ok: false, error: 'already_resolved' };
    if (input.outcome === 'UPHELD') return { ok: true };

    await tx.review.update({ where: { id: dispute.reviewId }, data: { overturnedAt: now } });
    // An overturned send-back becomes payable now, so it is dated now and
    // never lands in a period that was already paid. An overturned fix was
    // accepted and payable since the review and keeps its date.
    const sentBack = dispute.review.decision === 'SEND_BACK';
    const undone = await tx.assignment.updateMany({
      where: {
        id: dispute.assignmentId,
        status: 'SUBMITTED',
        reviewStatus: sentBack ? 'SENT_BACK' : 'FIXED',
      },
      data: { reviewStatus: 'APPROVED', ...(sentBack ? { reviewedAt: now } : {}) },
    });
    // nothing may change a submission while its dispute is open; if something
    // did, throwing rolls the whole overturn back and the dispute stays open
    if (undone.count !== 1) {
      throw new Error(`Dispute ${disputeId}: the submission is not in the state it was decided in`);
    }
    await refreshTaskStatus(dispute.assignment.taskId, tx, now);
    return { ok: true };
  });
}

export function countOpenDisputes(projectId: string) {
  return prisma.dispute.count({ where: { status: 'OPEN', assignment: { projectId } } });
}

const listed = {
  id: true,
  status: true,
  reason: true,
  createdAt: true,
  resolvedAt: true,
  openedBy: { select: { name: true } },
  resolvedBy: { select: { name: true } },
  review: {
    select: { decision: true, reviewerId: true, reviewer: { select: { name: true } } },
  },
  assignment: {
    select: { userId: true, task: { select: { externalId: true, data: true } } },
  },
} satisfies Prisma.DisputeSelect;

/** A project's disputes: the open ones, oldest first, and the latest settled ones. */
export async function listDisputes(projectId: string, settledTake = 20) {
  const [open, settled] = await Promise.all([
    prisma.dispute.findMany({
      where: { status: 'OPEN', assignment: { projectId } },
      orderBy: { createdAt: 'asc' },
      select: listed,
    }),
    prisma.dispute.findMany({
      where: { status: { not: 'OPEN' }, assignment: { projectId } },
      orderBy: { resolvedAt: 'desc' },
      take: settledTake,
      select: listed,
    }),
  ]);
  return { open, settled };
}

/** One dispute of a project with everything the decision page shows. */
export function findDispute(projectId: string, disputeId: string) {
  return prisma.dispute.findFirst({
    where: { id: disputeId, assignment: { projectId } },
    include: {
      openedBy: { select: { name: true } },
      resolvedBy: { select: { name: true } },
      review: { include: { reviewer: { select: { name: true } } } },
      assignment: { include: { task: true } },
    },
  });
}
