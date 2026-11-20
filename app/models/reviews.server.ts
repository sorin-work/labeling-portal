import {
  Prisma,
  type Assignment,
  type PrismaClient,
  type Review,
  type ReviewDecision,
  type ReviewStatus,
} from '@prisma/client';

import { holdCutoff } from '~/domain/review-hold';
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

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A date for raw SQL. The columns are timestamps without a zone that hold UTC,
 * and a bare parameter would be converted to the session's time zone first.
 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Why a reservation or a decision was refused. */
export type ReviewRefusal = 'not_pending' | 'held';

/** Filter: no other reviewer has a live hold on the submission. */
function freeFor(reviewerId: string, now: Date): Prisma.AssignmentWhereInput {
  return {
    OR: [
      { reviewHeldById: null },
      { reviewHeldById: reviewerId },
      { reviewHeldAt: { lte: holdCutoff(now) } },
    ],
  };
}

/** Tells a refused reviewer whether the submission is decided or just taken. */
async function refusal(db: Prisma.TransactionClient, assignmentId: string): Promise<ReviewRefusal> {
  const current = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: { status: true, reviewStatus: true },
  });
  const pending = current?.status === 'SUBMITTED' && current.reviewStatus === 'PENDING';
  return pending ? 'held' : 'not_pending';
}

/** Submissions waiting for review in a project, oldest first, with who holds each. */
export function listPendingReviews(
  projectId: string,
  opts: { userId?: string; take?: number; skip?: number } = {},
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
    skip: opts.skip ?? 0,
    select: {
      id: true,
      submittedAt: true,
      activeSeconds: true,
      reviewHeldById: true,
      reviewHeldAt: true,
      reviewHeldBy: { select: { name: true } },
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

/**
 * Reserves the next submission for the reviewer and returns its id: the one
 * they already hold, otherwise the oldest pending one that is not their own
 * work and that nobody else holds. Picking and marking are one statement, and
 * a row another reviewer is taking at the same moment is skipped instead of
 * waited for, so two reviewers never get the same submission.
 */
export async function reserveNextReview(
  projectId: string,
  reviewerId: string,
  now = new Date(),
  db: Db = prisma,
) {
  const cutoff = utc(holdCutoff(now));
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE "Assignment"
    SET "reviewHeldById" = ${reviewerId}, "reviewHeldAt" = ${utc(now)}
    WHERE id = (
      SELECT a.id
      FROM "Assignment" a
      WHERE a."projectId" = ${projectId}
        AND a.status = 'SUBMITTED'
        AND a."reviewStatus" = 'PENDING'
        AND a."userId" <> ${reviewerId}
        AND (
          a."reviewHeldById" IS NULL
          OR a."reviewHeldById" = ${reviewerId}
          OR a."reviewHeldAt" <= ${cutoff}
        )
      ORDER BY
        CASE
          WHEN a."reviewHeldById" = ${reviewerId} AND a."reviewHeldAt" > ${cutoff} THEN 0
          ELSE 1
        END,
        a."submittedAt",
        a.id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows[0] ?? null;
}

/**
 * Reserves one particular submission, for a reviewer who opened it from the
 * list. Refused when it is decided already or another reviewer holds it. A
 * reviewer keeps one reservation per project, so any other one is let go.
 */
export async function holdReview(
  assignmentId: string,
  reviewerId: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: ReviewRefusal }> {
  return prisma.$transaction(async (tx) => {
    const [held] = await tx.assignment.updateManyAndReturn({
      where: {
        id: assignmentId,
        status: 'SUBMITTED',
        reviewStatus: 'PENDING',
        userId: { not: reviewerId },
        ...freeFor(reviewerId, now),
      },
      data: { reviewHeldById: reviewerId, reviewHeldAt: now },
      select: { projectId: true },
    });
    if (!held) return { ok: false, error: await refusal(tx, assignmentId) };
    await tx.assignment.updateMany({
      where: { projectId: held.projectId, reviewHeldById: reviewerId, id: { not: assignmentId } },
      data: { reviewHeldById: null, reviewHeldAt: null },
    });
    return { ok: true };
  });
}

export type RecordedReview =
  { ok: true; review: Review; assignment: Assignment } | { ok: false; error: ReviewRefusal };

/**
 * Stores a review decision and updates the submission's review status. The
 * submission is taken with one conditional write: it must still be pending
 * and not held by another reviewer. Of two reviewers who decide at the same
 * moment the second finds it gone and nothing of theirs is stored.
 */
export async function recordReview(
  assignmentId: string,
  reviewerId: string,
  input: ReviewInput,
  now = new Date(),
): Promise<RecordedReview> {
  return prisma.$transaction(async (tx) => {
    const [assignment] = await tx.assignment.updateManyAndReturn({
      where: {
        id: assignmentId,
        status: 'SUBMITTED',
        reviewStatus: 'PENDING',
        ...freeFor(reviewerId, now),
      },
      data: {
        reviewStatus: STATUS_AFTER[input.decision],
        reviewedAt: now,
        reviewHeldById: null,
        reviewHeldAt: null,
      },
    });
    if (!assignment) return { ok: false, error: await refusal(tx, assignmentId) };
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
    await refreshTaskStatus(assignment.taskId, tx, now);
    return { ok: true, review, assignment };
  });
}
