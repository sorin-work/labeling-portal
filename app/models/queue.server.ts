import { Prisma, type Assignment, type Project } from '@prisma/client';

import { clampActiveSeconds, revisionSeconds } from '~/domain/active-time';
import type { Answer } from '~/domain/answers';
import { scoreAgainstGold } from '~/domain/gold';
import { decideReview, type SamplingDecision } from '~/domain/review-sampling';
import { parseTaskSchema } from '~/domain/task-schema';
import { prisma, utc } from '~/lib/db.server';

import { blockedByDispute } from './disputes.server';
import { isAnnotatorFlagged } from './quality.server';
import { refreshTaskStatus } from './tasks.server';

export type ClaimResult =
  | { ok: true; assignment: Assignment; resumed: boolean }
  | { ok: false; reason: 'inactive' | 'empty' | 'unqualified' };

const MAX_CLAIM_ATTEMPTS = 5;

/** A claim that ends (submitted, skipped, released, expired) drops its draft. */
const NO_DRAFT = { draft: Prisma.DbNull, draftSeconds: 0 };

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** The annotator's claim that is still within its time limit, if any. */
export function findActiveAssignment(projectId: string, userId: string, now = new Date()) {
  return prisma.assignment.findFirst({
    where: { projectId, userId, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: { claimedAt: 'desc' },
  });
}

/**
 * SQL condition on task `t`: open, not part of the qualification test, not
 * already claimed, done or skipped by this annotator, and (unless it is a gold
 * task) with fewer live claims and submissions than `overlap`.
 */
function eligibleFor(userId: string, now: Date, overlap: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    t.status = 'OPEN'
    AND NOT t."isQualification"
    AND NOT EXISTS (
      SELECT 1 FROM "Assignment" mine
      WHERE mine."taskId" = t.id AND mine."userId" = ${userId}
        AND mine.status IN ('ACTIVE', 'SUBMITTED', 'SKIPPED')
    )
    AND (
      t."isGold"
      OR (
        SELECT count(*) FROM "Assignment" a
        WHERE a."taskId" = t.id
          AND (a.status = 'SUBMITTED' OR (a.status = 'ACTIVE' AND a."expiresAt" > ${utc(now)}))
      ) < ${overlap}
    )
  )`;
}

/** Next task the annotator may work on, in import order. */
async function nextCandidate(project: Project, userId: string, now: Date) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t.id
    FROM "Task" t
    WHERE t."projectId" = ${project.id}
      AND ${eligibleFor(userId, now, Prisma.sql`${project.overlap}`)}
    ORDER BY t.position
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * Marks claims that ran past their time limit as expired so the task goes back
 * to the queue. Runs lazily whenever someone asks for work.
 */
export async function releaseExpiredClaims(projectId?: string, now = new Date()): Promise<number> {
  const result = await prisma.assignment.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now }, ...(projectId ? { projectId } : {}) },
    data: { status: 'EXPIRED', ...NO_DRAFT },
  });
  return result.count;
}

/** How many tasks the annotator could still pick up in each project. */
export async function countAvailable(
  projectIds: string[],
  userId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ projectId: string; count: bigint }>>`
    SELECT t."projectId", count(*) AS count
    FROM "Task" t
    JOIN "Project" p ON p.id = t."projectId"
    WHERE t."projectId" IN (${Prisma.join(projectIds)})
      AND ${eligibleFor(userId, now, Prisma.sql`p.overlap`)}
    GROUP BY t."projectId"`;
  return new Map(rows.map((r) => [r.projectId, Number(r.count)]));
}

/** Gives the annotator their current claim, or claims the next available task. */
export async function claimNextTask(
  project: Project,
  userId: string,
  now = new Date(),
): Promise<ClaimResult> {
  await releaseExpiredClaims(project.id, now);
  const existing = await findActiveAssignment(project.id, userId, now);
  if (existing) return { ok: true, assignment: existing, resumed: true };
  if (project.status !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  if (project.qualificationRequired) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
    });
    if (!member?.qualifiedAt) return { ok: false, reason: 'unqualified' };
  }

  // Two people can pick the same candidate at the same moment. Lock the task
  // row, check it is still eligible and only then claim it; if someone else
  // got there first, look for the next candidate.
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const taskId = await nextCandidate(project, userId, now);
    if (!taskId) return { ok: false, reason: 'empty' };

    const assignment = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
      const [check] = await tx.$queryRaw<Array<{ eligible: boolean }>>`
        SELECT ${eligibleFor(userId, now, Prisma.sql`${project.overlap}`)} AS eligible
        FROM "Task" t WHERE t.id = ${taskId}`;
      if (!check?.eligible) return null;
      return tx.assignment.create({
        data: {
          projectId: project.id,
          taskId,
          userId,
          claimedAt: now,
          expiresAt: addMinutes(now, project.timeLimitMinutes),
        },
      });
    });
    if (assignment) return { ok: true, assignment, resumed: false };
  }
  return { ok: false, reason: 'empty' };
}

export type AssignmentError = 'not_found' | 'not_active' | 'expired';

async function ownActive(assignmentId: string, userId: string) {
  const assignment = await prisma.assignment.findFirst({ where: { id: assignmentId, userId } });
  if (!assignment) return { error: 'not_found' as const };
  if (assignment.status !== 'ACTIVE') return { error: 'not_active' as const };
  return { assignment };
}

export { clampActiveSeconds };

/**
 * Whether a new submission in a project that reviews work goes to a reviewer.
 * The annotator's history is only read when the project reviews a share.
 */
async function sampleForReview(
  projectId: string,
  userId: string,
  samplePercent: number,
  random: () => number,
): Promise<SamplingDecision> {
  if (samplePercent >= 100) {
    return decideReview({ samplePercent, sentToReviewBefore: 0, flagged: false }, random);
  }
  const [sentToReviewBefore, flagged] = await Promise.all([
    prisma.assignment.count({
      where: { projectId, userId, status: 'SUBMITTED', reviewStatus: { not: 'NOT_REQUIRED' } },
    }),
    isAnnotatorFlagged(projectId, userId),
  ]);
  return decideReview({ samplePercent, sentToReviewBefore, flagged }, random);
}

/**
 * Stores the answer on the annotator's claim. `random` is the source for the
 * review sample (see `decideReview`); tests pass a fixed one.
 */
export async function submitAssignment(
  assignmentId: string,
  userId: string,
  input: {
    answer: Prisma.InputJsonValue;
    activeSeconds: number;
    reviewRequired: boolean;
    /** share of submissions that go to review; everything when left out */
    reviewSamplePercent?: number;
  },
  now = new Date(),
  random: () => number = Math.random,
): Promise<{ ok: true; assignment: Assignment } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (found.assignment.expiresAt <= now) {
    // Too late: the answer is refused and the claim is marked as expired, but
    // only while it is still active. When the same form is posted twice
    // around the deadline, the first post may have been in time and stored,
    // and that submission must not be turned into an expired claim.
    const expired = await prisma.assignment.updateMany({
      where: { id: assignmentId, status: 'ACTIVE' },
      data: { status: 'EXPIRED', ...NO_DRAFT },
    });
    return { ok: false, error: expired.count > 0 ? 'expired' : 'not_active' };
  }

  // gold tasks are scored against their known answer instead of being reviewed
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: found.assignment.taskId },
    include: { project: { select: { schema: true, rateCents: true, payMode: true } } },
  });
  let goldScore: number | null = null;
  if (task.isGold && task.goldAnswer) {
    const schema = parseTaskSchema(task.project.schema);
    if (schema.ok) {
      goldScore = scoreAgainstGold(
        schema.schema,
        input.answer as Answer,
        task.goldAnswer as Answer,
      );
    }
  }

  // The sample is drawn here, once, and the outcome is stored. Nothing that
  // reads the submission later draws again.
  const sampling: SamplingDecision =
    input.reviewRequired && !task.isGold
      ? await sampleForReview(
          found.assignment.projectId,
          userId,
          input.reviewSamplePercent ?? 100,
          random,
        )
      : { review: false, sample: null };

  const assignment = await prisma.$transaction(async (tx) => {
    // only a claim that is still active is written, so a form posted twice
    // cannot replace the first outcome with a second draw
    const [submitted] = await tx.assignment.updateManyAndReturn({
      where: { id: assignmentId, status: 'ACTIVE' },
      data: {
        status: 'SUBMITTED',
        submittedAt: now,
        // the rate is frozen here, in the write that submits the work: a
        // later change of the project's rate does not reprice it
        rateCents: task.project.rateCents,
        payMode: task.project.payMode,
        answer: input.answer,
        goldScore,
        reviewStatus: sampling.review ? 'PENDING' : 'NOT_REQUIRED',
        reviewSample: sampling.sample,
        activeSeconds: clampActiveSeconds(input.activeSeconds, found.assignment.claimedAt, now),
        ...NO_DRAFT,
      },
    });
    // work that no reviewer will see is accepted at once and can complete the
    // task, in the same transaction as the write that accepts it
    if (submitted && !sampling.review && !task.isGold) {
      await refreshTaskStatus(submitted.taskId, tx, now);
    }
    return submitted;
  });
  if (!assignment) return { ok: false, error: 'not_active' };
  return { ok: true, assignment };
}

export async function skipAssignment(
  assignmentId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  // conditional for the same reason as in submitAssignment: a second post must
  // not turn a submission that was just stored into a skip
  const skipped = await prisma.assignment.updateMany({
    where: { id: assignmentId, status: 'ACTIVE' },
    data: { status: 'SKIPPED', skipReason: reason, ...NO_DRAFT },
  });
  return skipped.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
}

/** What crediting a revision needs to know about the submission. */
const REVISION_FIELDS = {
  reviewedAt: true,
  submittedAt: true,
  activeSeconds: true,
  draftSeconds: true,
  project: { select: { timeLimitMinutes: true } },
} satisfies Prisma.AssignmentSelect;

type Revised = Prisma.AssignmentGetPayload<{ select: typeof REVISION_FIELDS }>;

/**
 * The time a revision is credited, for the resubmission and for the draft
 * that keeps it across a reload alike. Revising starts when the reviewer
 * sends the work back, and `revisionSeconds` holds it to the project's time
 * limit and to the total an assignment may be credited.
 */
function creditedRevision(assignment: Revised, reported: number, now: Date): number {
  return revisionSeconds({
    reported,
    reviewedAt: assignment.reviewedAt ?? assignment.submittedAt ?? now,
    now,
    limitSeconds: assignment.project.timeLimitMinutes * 60,
    credited: assignment.activeSeconds,
  });
}

/**
 * Replaces the answer on a submission a reviewer sent back and puts it in the
 * review queue again. Only the annotator who made it can do this, and not
 * while they dispute the decision: it is revise or dispute, never both. The
 * time spent revising is added to the active time, within the bounds of
 * `revisionSeconds`. The rate stays the one frozen at the first submission.
 */
export async function resubmitAssignment(
  assignmentId: string,
  userId: string,
  input: { answer: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: AssignmentError | 'disputed' }> {
  return prisma.$transaction(async (tx) => {
    if (await blockedByDispute(tx, assignmentId)) return { ok: false, error: 'disputed' };
    const sentBack: Prisma.AssignmentWhereInput = {
      id: assignmentId,
      userId,
      status: 'SUBMITTED',
      reviewStatus: 'SENT_BACK',
    };
    const current = await tx.assignment.findFirst({ where: sentBack, select: REVISION_FIELDS });
    // the page counts on from the time saved with the draft, so the form has
    // at least that much; the larger one counts if it does not
    const reported = Number.isFinite(input.activeSeconds) ? input.activeSeconds : 0;
    const revising = current
      ? creditedRevision(current, Math.max(reported, current.draftSeconds), now)
      : 0;
    const result = await tx.assignment.updateMany({
      // still sent back: a form posted twice adds its time only once
      where: sentBack,
      data: {
        answer: input.answer,
        reviewStatus: 'PENDING',
        submittedAt: now,
        reviewedAt: null,
        activeSeconds: { increment: revising },
        ...NO_DRAFT,
      },
    });
    if (result.count === 0) {
      const exists = await tx.assignment.count({ where: { id: assignmentId, userId } });
      return { ok: false, error: exists ? 'not_active' : 'not_found' };
    }
    return { ok: true };
  });
}

/** Hands a claim back without an answer so someone else can take it. */
export async function releaseAssignment(
  assignmentId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const released = await prisma.assignment.updateMany({
    where: { id: assignmentId, status: 'ACTIVE' },
    data: { status: 'RELEASED', ...NO_DRAFT },
  });
  return released.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
}

/**
 * Keeps unfinished work on a claim so that a reload does not lose it. The
 * draft is stored as it is; only submitting validates. `draft` is left out
 * when the answer did not change and the save only carries working time. That
 * time never goes down, so an older tab cannot take seconds away again.
 */
export async function saveDraft(
  assignmentId: string,
  userId: string,
  input: { draft?: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<{ ok: true; draftSeconds: number } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (found.assignment.expiresAt <= now) return { ok: false, error: 'expired' };
  const seconds = clampActiveSeconds(input.activeSeconds, found.assignment.claimedAt, now);
  const draft =
    input.draft === undefined
      ? Prisma.empty
      : Prisma.sql`, "draft" = ${JSON.stringify(input.draft)}::jsonb`;
  // One statement: the claim can be submitted or released since the check
  // above, and two tabs can save at the same moment without one of them
  // lowering the time again.
  const saved = await prisma.$queryRaw<Array<{ draftSeconds: number }>>`
    UPDATE "Assignment"
    SET "draftSeconds" = GREATEST("draftSeconds", ${seconds}::int)${draft}
    WHERE id = ${assignmentId} AND "userId" = ${userId} AND status = 'ACTIVE'
    RETURNING "draftSeconds"`;
  if (saved.length === 0) return { ok: false, error: 'not_active' };
  return { ok: true, draftSeconds: saved[0].draftSeconds };
}

/**
 * The same for the revise page. That assignment is submitted, not active, so
 * the guard is the one `resubmitAssignment` uses: the annotator's own
 * submission, while it is sent back and not under dispute. Work that is
 * disputed cannot be revised, so no revision of it is saved either. The time
 * spent revising is kept with the draft, within the same bounds as a
 * resubmission credits it, and never goes down.
 */
export async function saveRevisionDraft(
  assignmentId: string,
  userId: string,
  input: { draft?: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<
  { ok: true; draftSeconds: number } | { ok: false; error: AssignmentError | 'disputed' }
> {
  return prisma.$transaction(async (tx) => {
    if (await blockedByDispute(tx, assignmentId)) return { ok: false, error: 'disputed' };
    const current = await tx.assignment.findFirst({
      where: { id: assignmentId, userId },
      select: REVISION_FIELDS,
    });
    if (!current) return { ok: false, error: 'not_found' };
    const seconds = creditedRevision(current, input.activeSeconds, now);
    const draft =
      input.draft === undefined
        ? Prisma.empty
        : Prisma.sql`, "draft" = ${JSON.stringify(input.draft)}::jsonb`;
    // one statement, for the same reasons as in saveDraft
    const saved = await tx.$queryRaw<Array<{ draftSeconds: number }>>`
      UPDATE "Assignment"
      SET "draftSeconds" = GREATEST("draftSeconds", ${seconds}::int)${draft}
      WHERE id = ${assignmentId} AND "userId" = ${userId}
        AND status = 'SUBMITTED' AND "reviewStatus" = 'SENT_BACK'
      RETURNING "draftSeconds"`;
    if (saved.length === 0) return { ok: false, error: 'not_active' };
    return { ok: true, draftSeconds: saved[0].draftSeconds };
  });
}

/**
 * Gives the annotator another full time limit on their claim. Allowed once,
 * and only before the claim has run out.
 */
export async function extendAssignment(
  assignmentId: string,
  userId: string,
  minutes: number,
  now = new Date(),
): Promise<
  { ok: true; expiresAt: Date } | { ok: false; error: AssignmentError | 'already_extended' }
> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (found.assignment.expiresAt <= now) return { ok: false, error: 'expired' };
  if (found.assignment.extendedAt) return { ok: false, error: 'already_extended' };
  const expiresAt = addMinutes(found.assignment.expiresAt, minutes);
  await prisma.assignment.update({
    where: { id: assignmentId },
    data: { expiresAt, extendedAt: now },
  });
  return { ok: true, expiresAt };
}
