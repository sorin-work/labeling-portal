import { Prisma, type Project } from '@prisma/client';

import { validateAnswer, type Answer } from '~/domain/answers';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

import { projectSchema } from './projects.server';

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
 * Whether the user has labeled the task: a submission of theirs, accepted or
 * not, or a claim they are working on. They may not settle it.
 */
async function labeledBy(db: Prisma.TransactionClient, taskId: string, userId: string) {
  const mine = await db.assignment.count({
    where: { taskId, userId, status: { in: ['SUBMITTED', 'ACTIVE'] } },
  });
  return mine > 0;
}

export async function canAdjudicate(taskId: string, userId: string): Promise<boolean> {
  return !(await labeledBy(prisma, taskId, userId));
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
      if (task.consensus === null) return { ok: false, error: 'no_consensus' };
      answer = task.consensus as Answer;
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
        adjudicatedById: actorId,
        adjudicatedAt: now,
        adjudicatedNote: note,
      },
    });
    if (settled.count === 0) return { ok: false, error: 'not_waiting' };
    await tx.activity.create({
      data: {
        projectId: project.id,
        actorId,
        action: 'task.adjudicated',
        detail: { taskId, position: task.position, how: choice.kind },
        createdAt: now,
      },
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
    const moved = await tx.task.updateMany({
      where: { id: taskId, status: 'OPEN', extraSlots: { gt: 0 } },
      data: { status: 'ADJUDICATION', escalatedAt: now },
    });
    if (moved.count === 0) return { ok: false, error: 'not_waiting' };
    await tx.activity.create({
      data: {
        projectId: project.id,
        actorId,
        action: 'task.escalated',
        detail: { taskId, position: task.position },
        createdAt: now,
      },
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
    batch: task.batch.name,
    agreement: task.agreement,
    answers: task.assignments.length,
    extraSlots: task.extraSlots,
    hasConsensus: task.consensus !== null,
    escalatedAt: task.escalatedAt,
    ownWork: task.assignments.some((a) => a.userId === userId),
  }));
}

export function countAdjudication(projectId: string) {
  return prisma.task.count({ where: { projectId, status: 'ADJUDICATION' } });
}
