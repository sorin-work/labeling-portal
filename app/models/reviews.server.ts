import {
  Prisma,
  type Assignment,
  type PrismaClient,
  type Review,
  type ReviewDecision,
  type ReviewStatus,
} from '@prisma/client';

import { payableSince } from '~/domain/payouts';
import { holdCutoff } from '~/domain/review-hold';
import { spotCheckRefusal, type SpotCheckForm, type SpotCheckRefusal } from '~/domain/spot-check';
import { lockTaskOfAssignment, prisma, retryOnLockConflict, utc } from '~/lib/db.server';

import { logActivity } from './activity.server';
import { notify } from './notifications.server';
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
  return retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      // Every row this touches, locked in one statement in id order: the one
      // to reserve and the reviewer's other reservations in its project. Two
      // reviewers taking over each other's lapsed reservations then queue
      // instead of each holding one row and waiting for the other.
      await tx.$queryRaw`
      SELECT a.id FROM "Assignment" a
      WHERE a.id = ${assignmentId}
         OR (
           a."reviewHeldById" = ${reviewerId}
           AND a."projectId" = (SELECT t."projectId" FROM "Assignment" t WHERE t.id = ${assignmentId})
         )
      ORDER BY a.id
      FOR UPDATE`;
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
    }),
  );
}

/**
 * Gives the reviewer who holds a submission another full period. The review
 * page asks for this while the reviewer is working, and a posted decision
 * that does not validate does the same. One conditional write: it only
 * touches a waiting submission whose hold is still theirs, so it cannot take
 * a submission back from a reviewer who reserved it in the meantime.
 */
export async function renewReviewHold(
  assignmentId: string,
  reviewerId: string,
  now = new Date(),
): Promise<boolean> {
  const renewed = await prisma.assignment.updateMany({
    where: {
      id: assignmentId,
      status: 'SUBMITTED',
      reviewStatus: 'PENDING',
      reviewHeldById: reviewerId,
    },
    data: { reviewHeldAt: now },
  });
  return renewed.count > 0;
}

export type RecordedReview =
  { ok: true; review: Review; assignment: Assignment } | { ok: false; error: ReviewRefusal };

/**
 * The audit entry of a review decision: whose work, which task, the decision
 * and the QA score. The review row holds the rest; the feedback and a
 * corrected answer are not copied here.
 */
async function logDecision(
  tx: Prisma.TransactionClient,
  assignment: { id: string; projectId: string; taskId: string; userId: string },
  reviewerId: string,
  input: ReviewInput,
  now: Date,
) {
  const [task, annotator] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: assignment.taskId }, select: { position: true } }),
    tx.user.findUniqueOrThrow({ where: { id: assignment.userId }, select: { name: true } }),
  ]);
  await logActivity(tx, {
    projectId: assignment.projectId,
    actorId: reviewerId,
    action: 'review.decided',
    detail: {
      assignmentId: assignment.id,
      taskId: assignment.taskId,
      position: task.position,
      userId: assignment.userId,
      userName: annotator.name,
      decision: input.decision,
      qaScore: input.qaScore,
    },
    createdAt: now,
  });
}

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
    // the task row before the assignment row, as everywhere (lockTaskOfAssignment)
    await lockTaskOfAssignment(tx, assignmentId);
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
        // approved or fixed work is payable from the review, sent-back work is not
        payableAt: payableSince(STATUS_AFTER[input.decision], now),
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
    await logDecision(tx, assignment, reviewerId, input, now);
    // the annotator hears of work that came back or was corrected; an
    // approval needs nothing from them
    if (input.decision !== 'APPROVE') {
      const [project, task, reviewer] = await Promise.all([
        tx.project.findUniqueOrThrow({
          where: { id: assignment.projectId },
          select: { orgId: true, name: true },
        }),
        tx.task.findUniqueOrThrow({ where: { id: assignment.taskId }, select: { position: true } }),
        tx.user.findUniqueOrThrow({ where: { id: reviewerId }, select: { name: true } }),
      ]);
      await notify(
        tx,
        [
          {
            userId: assignment.userId,
            orgId: project.orgId,
            projectId: assignment.projectId,
            kind: input.decision === 'SEND_BACK' ? 'review.sent_back' : 'review.fixed',
            link: `/my-work/${assignment.id}`,
            detail: { projectName: project.name, position: task.position, actorName: reviewer.name },
            createdAt: now,
          },
        ],
        reviewerId,
      );
    }
    return { ok: true, review, assignment };
  });
}

export type SpotCheckResult =
  { ok: true; review: Review } | { ok: false; error: SpotCheckRefusal | 'not_found' };

/**
 * Records a spot check on accepted work that no reviewer has seen. Nothing
 * about the submission changes: not its status, its payable date, its task
 * or the consensus. The decision is a review row with `spotCheck` set, and
 * an audit entry.
 *
 * It changes no assignment's state and locks no task or clock, so it takes
 * only the submission's row (docs/architecture.md, "Lock order"), and checks
 * under that lock that no review exists yet: of two reviewers spot checking
 * at once, the second is refused.
 */
export async function recordSpotCheck(
  assignmentId: string,
  reviewerId: string,
  input: SpotCheckForm,
  now = new Date(),
): Promise<SpotCheckResult> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${assignmentId} FOR UPDATE`;
    const assignment = await tx.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        task: { select: { isGold: true, isQualification: true } },
        _count: { select: { reviews: true } },
      },
    });
    if (!assignment) return { ok: false, error: 'not_found' };
    const refused = spotCheckRefusal({
      status: assignment.status,
      reviewStatus: assignment.reviewStatus,
      isGold: assignment.task.isGold,
      isQualification: assignment.task.isQualification,
      reviews: assignment._count.reviews,
      ownWork: assignment.userId === reviewerId,
    });
    if (refused) return { ok: false, error: refused };
    const review = await tx.review.create({
      data: {
        assignmentId,
        reviewerId,
        decision: input.verdict,
        qaScore: input.qaScore,
        feedback: input.feedback,
        spotCheck: true,
        createdAt: now,
      },
    });
    const [task, annotator] = await Promise.all([
      tx.task.findUniqueOrThrow({ where: { id: assignment.taskId }, select: { position: true } }),
      tx.user.findUniqueOrThrow({ where: { id: assignment.userId }, select: { name: true } }),
    ]);
    await logActivity(tx, {
      projectId: assignment.projectId,
      actorId: reviewerId,
      action: 'review.spot_checked',
      detail: {
        assignmentId,
        taskId: assignment.taskId,
        position: task.position,
        userId: assignment.userId,
        userName: annotator.name,
        decision: input.verdict,
        qaScore: input.qaScore,
      },
      createdAt: now,
    });
    return { ok: true, review };
  });
}

/**
 * The reviewer who holds a submission lets go of it before the hold runs
 * out, so another reviewer can take it at once. One conditional write on the
 * hold being theirs, so it cannot free a submission someone else took over.
 */
export async function letGoOfReviewHold(
  assignmentId: string,
  reviewerId: string,
): Promise<boolean> {
  const freed = await prisma.assignment.updateMany({
    where: {
      id: assignmentId,
      status: 'SUBMITTED',
      reviewStatus: 'PENDING',
      reviewHeldById: reviewerId,
    },
    data: { reviewHeldById: null, reviewHeldAt: null },
  });
  return freed.count > 0;
}

/**
 * A manager frees a live hold from the review queue, with an audit entry.
 * `holderId` is the reviewer the queue showed: the write only goes through
 * while that reviewer still holds it, so a hold that changed hands since the
 * page loaded is left alone. Only the submission's row is written.
 */
export async function releaseReviewHold(
  project: { id: string; orgId: string },
  assignmentId: string,
  holderId: string,
  actorId: string,
  now = new Date(),
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [freed] = await tx.assignment.updateManyAndReturn({
      where: {
        id: assignmentId,
        projectId: project.id,
        status: 'SUBMITTED',
        reviewStatus: 'PENDING',
        reviewHeldById: holderId,
        reviewHeldAt: { gt: holdCutoff(now) },
      },
      data: { reviewHeldById: null, reviewHeldAt: null },
      select: { taskId: true, userId: true },
    });
    if (!freed) return false;
    const [task, holder, annotator] = await Promise.all([
      tx.task.findUniqueOrThrow({ where: { id: freed.taskId }, select: { position: true } }),
      tx.user.findUniqueOrThrow({ where: { id: holderId }, select: { name: true } }),
      tx.user.findUniqueOrThrow({ where: { id: freed.userId }, select: { name: true } }),
    ]);
    await logActivity(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorId,
      action: 'review.hold_released',
      detail: {
        assignmentId,
        taskId: freed.taskId,
        position: task.position,
        holderId,
        holderName: holder.name,
        userName: annotator.name,
      },
      createdAt: now,
    });
    return true;
  });
}
