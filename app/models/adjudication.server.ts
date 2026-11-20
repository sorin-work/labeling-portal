import { Prisma, type Project } from '@prisma/client';

import { validateAnswer, type Answer } from '~/domain/answers';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

import { logActivity } from './activity.server';
import { projectSchema } from './projects.server';
import { acceptedAnswers } from './tasks.server';

/** What the adjudicator settles a task with. */
export type AdjudicationChoice =
  /** the final answer of one accepted submission of the task */
  | { kind: 'submission'; assignmentId: string }
  /** the consensus the accepted answers already have, when a majority made one */
  | { kind: 'consensus' }
  /** an answer of their own, checked like a labeling answer */
  | { kind: 'own'; answer: unknown };

export type AdjudicationRefusal =
  | { error: 'not_found' }
  | { error: 'not_waiting' }
  | { error: 'own_work' }
  | { error: 'no_consensus' }
  | { error: 'no_submission' }
  | { error: 'invalid'; message: string };

/**
 * Whether the user had a hand in the answers of the task, and so may not
 * settle it: a submission or a claim of theirs, accepted or not, a fix of
 * theirs in a review (the corrected answer is one of the answers), on this
 * task or on any task of its gold group (the task it was copied from and that
 * task's copies, which hold the same item).
 */
export async function labeledBy(
  db: Prisma.TransactionClient,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db.$queryRaw<Array<{ labeled: boolean }>>`
    WITH task AS (SELECT id, "goldSourceId" FROM "Task" WHERE id = ${taskId}),
    item AS (
      SELECT t.id FROM "Task" t, task
      WHERE t.id = task.id
         OR t.id = task."goldSourceId"
         OR t."goldSourceId" = COALESCE(task."goldSourceId", task.id)
    )
    SELECT EXISTS (
      SELECT 1 FROM "Assignment" a
      WHERE a."taskId" IN (SELECT id FROM item) AND a."userId" = ${userId}
        AND a.status IN ('SUBMITTED', 'ACTIVE')
    ) OR EXISTS (
      SELECT 1 FROM "Review" r JOIN "Assignment" a ON a.id = r."assignmentId"
      WHERE a."taskId" IN (SELECT id FROM item) AND r."reviewerId" = ${userId}
        AND r.decision = 'FIX'
    ) AS labeled`;
  return row?.labeled ?? false;
}

/**
 * Settles a task in adjudication. The chosen answer becomes the task's
 * consensus, the task completes, and who did it, when and why are stored on
 * it. The write names the state it expects, so two reviewers settling the
 * same task at once leave one decision. Submissions, their reviews and their
 * pay stay as they are.
 */
export async function adjudicateTask(
  project: Project,
  taskId: string,
  actorId: string,
  choice: AdjudicationChoice,
  note: string,
  now = new Date(),
): Promise<{ ok: true } | ({ ok: false } & AdjudicationRefusal)> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR NO KEY UPDATE`;
    const task = await tx.task.findFirst({ where: { id: taskId, projectId: project.id } });
    if (!task) return { ok: false, error: 'not_found' };
    if (task.status !== 'ADJUDICATION') return { ok: false, error: 'not_waiting' };
    if (await labeledBy(tx, taskId, actorId)) return { ok: false, error: 'own_work' };

    let answer: Answer;
    if (choice.kind === 'consensus') {
      // what the majority said while the task waited; not a result before this
      if (task.majority === null) return { ok: false, error: 'no_consensus' };
      answer = task.majority as Answer;
    } else if (choice.kind === 'submission') {
      const picked = await tx.assignment.findFirst({
        where: {
          id: choice.assignmentId,
          taskId,
          status: 'SUBMITTED',
          reviewStatus: { in: [...ACCEPTED_STATUSES] },
        },
        include: { reviews: true },
      });
      if (!picked) return { ok: false, error: 'no_submission' };
      answer = finalAnswer<Answer>(picked.answer, picked.reviews);
    } else {
      const checked = validateAnswer(projectSchema(project), task.data, choice.answer);
      if (!checked.ok) return { ok: false, error: 'invalid', message: checked.error };
      answer = checked.answer;
    }

    const settled = await tx.task.updateMany({
      where: { id: taskId, status: 'ADJUDICATION', adjudicatedAt: null },
      data: {
        status: 'COMPLETE',
        completedAt: now,
        consensus: answer as Prisma.InputJsonValue,
        majority: Prisma.DbNull,
        adjudicatedById: actorId,
        adjudicatedAt: now,
        adjudicatedNote: note,
      },
    });
    if (settled.count === 0) return { ok: false, error: 'not_waiting' };
    await logActivity(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorId,
      action: 'task.adjudicated',
      detail: { taskId, position: task.position, how: choice.kind },
      createdAt: now,
    });
    return { ok: true };
  });
}

/**
 * Sends a task that waits for an extra annotator to adjudication straight
 * away, for when nobody is left who could take the slot. Managers only.
 */
export async function sendToAdjudication(
  project: Project,
  taskId: string,
  actorId: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_waiting' }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR NO KEY UPDATE`;
    const task = await tx.task.findFirst({ where: { id: taskId, projectId: project.id } });
    if (!task) return { ok: false, error: 'not_found' };
    // what the answers so far say, for "keep the consensus" on the task page
    const merged = (await acceptedAnswers(tx, taskId, project.schema)).merge();
    const moved = await tx.task.updateMany({
      where: { id: taskId, status: 'OPEN', extraSlots: { gt: 0 } },
      data: {
        status: 'ADJUDICATION',
        escalatedAt: now,
        majority: merged.consensus,
        agreement: merged.agreement,
      },
    });
    if (moved.count === 0) return { ok: false, error: 'not_waiting' };
    await logActivity(tx, {
      orgId: project.orgId,
      projectId: project.id,
      actorId,
      action: 'task.escalated',
      detail: { taskId, position: task.position },
      createdAt: now,
    });
    return { ok: true };
  });
}

/** Tasks waiting for adjudication, the longest waiting first. */
export async function listAdjudication(projectId: string, userId: string) {
  const tasks = await prisma.task.findMany({
    where: { projectId, status: 'ADJUDICATION' },
    orderBy: [{ escalatedAt: 'asc' }, { position: 'asc' }],
    include: {
      batch: { select: { name: true } },
      assignments: {
        where: { status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
        select: { userId: true },
      },
    },
  });
  return tasks.map((task) => ({
    id: task.id,
    position: task.position,
    externalId: task.externalId,
    data: task.data,
    batch: task.batch.name,
    agreement: task.agreement,
    answers: task.assignments.length,
    extraSlots: task.extraSlots,
    hasConsensus: task.majority !== null,
    escalatedAt: task.escalatedAt,
    ownWork: task.assignments.some((a) => a.userId === userId),
  }));
}

export function countAdjudication(projectId: string) {
  return prisma.task.count({ where: { projectId, status: 'ADJUDICATION' } });
}
