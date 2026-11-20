import { Prisma } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import { decideCompletion } from '~/domain/adjudication';
import { consensus } from '~/domain/consensus';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { parseTaskSchema } from '~/domain/task-schema';

/**
 * A task is complete once `overlap` submissions (plus any extra slots) have
 * been accepted; the accepted answers are then merged into a consensus. With
 * an agreement threshold on the project, a task whose answers agree less gets
 * another annotator, up to the project's number of extras, and then goes to
 * adjudication (`decideCompletion`). Called after anything that changes a
 * submission's review state, inside the transaction that made the change.
 *
 * The rule is only applied to a task that is open. A task that is complete or
 * waiting for adjudication keeps its status while its answers stay, whatever
 * the settings say now; a task that a person adjudicated is never touched.
 *
 * The task row is locked before the accepted submissions are counted. Without
 * that, two acceptances of one task at the same moment each count only their
 * own, and the task stays open with its overlap met. With the lock the second
 * one waits here and then counts both.
 */
export async function refreshTaskStatus(
  taskId: string,
  db: Prisma.TransactionClient,
  now = new Date(),
) {
  await db.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR NO KEY UPDATE`;
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      project: {
        select: { overlap: true, schema: true, agreementThreshold: true, maxExtraAnnotators: true },
      },
    },
  });
  // settled by a person: their answer is the result, later reviews or not
  if (task.adjudicatedAt) return task;

  const { count: acceptedCount, merge } = await acceptedAnswers(db, taskId, task.project.schema);
  const needed = task.project.overlap + task.extraSlots;

  if (task.status === 'ADJUDICATION') {
    // waits for a person; what they are shown follows the accepted answers,
    // and it is no result until they settle it
    const merged = merge();
    return db.task.update({
      where: { id: taskId },
      data: { majority: merged.consensus, agreement: merged.agreement },
    });
  }
  if (task.status === 'COMPLETE') {
    if (acceptedCount >= needed) return db.task.update({ where: { id: taskId }, data: merge() });
    return db.task.update({
      where: { id: taskId },
      data: { status: 'OPEN', completedAt: null, consensus: Prisma.DbNull, agreement: null },
    });
  }

  if (acceptedCount < needed) return task;
  const merged = merge();
  const decision = decideCompletion({
    accepted: acceptedCount,
    overlap: task.project.overlap,
    extraSlots: task.extraSlots,
    threshold: task.project.agreementThreshold,
    maxExtra: task.project.maxExtraAnnotators,
    agreement: merged.agreement ?? 1,
  });
  switch (decision.step) {
    case 'extra':
      // one more slot; the task stays open and is handed out again
      return db.task.update({
        where: { id: taskId },
        data: { extraSlots: { increment: 1 }, agreement: merged.agreement },
      });
    case 'adjudicate':
      return db.task.update({
        where: { id: taskId },
        data: {
          status: 'ADJUDICATION',
          escalatedAt: now,
          majority: merged.consensus,
          agreement: merged.agreement,
          consensus: Prisma.DbNull,
        },
      });
    default:
      return db.task.update({
        where: { id: taskId },
        data: { status: 'COMPLETE', completedAt: task.completedAt ?? now, ...merged },
      });
  }
}

/**
 * The accepted answers of a task, counted and merged. `merge` gives the
 * consensus (null when there is no majority) and the agreement, as columns.
 */
export async function acceptedAnswers(
  db: Prisma.TransactionClient,
  taskId: string,
  projectSchema: Prisma.JsonValue,
) {
  const accepted = await db.assignment.findMany({
    where: { taskId, status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
    include: { reviews: true },
  });
  const merge = () => {
    const schema = parseTaskSchema(projectSchema);
    const merged = schema.ok
      ? consensus(
          schema.schema,
          accepted.map((a) => finalAnswer<Answer>(a.answer, a.reviews)),
        )
      : null;
    return {
      consensus: merged?.answer ? (merged.answer as Prisma.InputJsonValue) : Prisma.DbNull,
      agreement: merged?.agreement ?? null,
    };
  };
  return { count: accepted.length, merge };
}
