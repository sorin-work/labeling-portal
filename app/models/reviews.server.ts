import type { Prisma, ReviewDecision, ReviewStatus } from '@prisma/client';

import { prisma } from '~/lib/db.server';

import { refreshTaskStatus } from './tasks.server';

const STATUS_AFTER: Record<ReviewDecision, ReviewStatus> = {
  APPROVE: 'APPROVED',
  SEND_BACK: 'SENT_BACK',
  FIX: 'FIXED',
};

export type ReviewInput = {
  decision: ReviewDecision;
  qaScore: number | null;
  feedback: string;
  correctedAnswer?: Prisma.InputJsonValue;
};

/** Submissions waiting for review in a project, oldest first. */
export function listPendingReviews(
  projectId: string,
  opts: { userId?: string; take?: number } = {},
) {
  return prisma.assignment.findMany({
    where: {
      projectId,
      status: 'SUBMITTED',
      reviewStatus: 'PENDING',
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
    orderBy: { submittedAt: 'asc' },
    take: opts.take ?? 50,
    select: {
      id: true,
      submittedAt: true,
      activeSeconds: true,
      user: { select: { id: true, name: true } },
      task: { select: { id: true, externalId: true, data: true } },
    },
  });
}

export function countPendingReviews(projectId: string) {
  return prisma.assignment.count({
    where: { projectId, status: 'SUBMITTED', reviewStatus: 'PENDING' },
  });
}

/** Annotators with work waiting for review, with how much each has waiting. */
export async function pendingByAnnotator(projectId: string) {
  const groups = await prisma.assignment.groupBy({
    by: ['userId'],
    where: { projectId, status: 'SUBMITTED', reviewStatus: 'PENDING' },
    _count: { _all: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: groups.map((g) => g.userId) } },
    select: { id: true, name: true },
  });
  return users
    .map((u) => ({ ...u, count: groups.find((g) => g.userId === u.id)?._count._all ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The oldest pending submission the reviewer did not make themselves. */
export function nextPendingReview(projectId: string, reviewerId: string) {
  return prisma.assignment.findFirst({
    where: {
      projectId,
      status: 'SUBMITTED',
      reviewStatus: 'PENDING',
      userId: { not: reviewerId },
    },
    orderBy: { submittedAt: 'asc' },
    select: { id: true },
  });
}

/** Stores a review decision and updates the submission's review status. */
export async function recordReview(
  assignmentId: string,
  reviewerId: string,
  input: ReviewInput,
  now = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const review = await tx.review.create({
      data: {
        assignmentId,
        reviewerId,
        decision: input.decision,
        qaScore: input.qaScore,
        feedback: input.feedback,
        correctedAnswer: input.decision === 'FIX' ? input.correctedAnswer : undefined,
        createdAt: now,
      },
    });
    const assignment = await tx.assignment.update({
      where: { id: assignmentId },
      data: { reviewStatus: STATUS_AFTER[input.decision], reviewedAt: now },
    });
    await refreshTaskStatus(assignment.taskId, tx, now);
    return { review, assignment };
  });
}
