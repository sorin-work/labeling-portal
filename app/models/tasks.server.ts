import { Prisma } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import { consensus } from '~/domain/consensus';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { parseTaskSchema } from '~/domain/task-schema';

/**
 * A task is complete once `overlap` submissions have been accepted; the
 * accepted answers are then merged into a consensus. Called after anything
 * that changes a submission's review state, inside the transaction that made
 * the change.
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
    include: { project: { select: { overlap: true, schema: true } } },
  });
  const accepted = await db.assignment.findMany({
    where: { taskId, status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
    include: { reviews: true },
  });

  if (accepted.length >= task.project.overlap) {
    const schema = parseTaskSchema(task.project.schema);
    const merged = schema.ok
      ? consensus(
          schema.schema,
          accepted.map((a) => finalAnswer<Answer>(a.answer, a.reviews)),
        )
      : null;
    return db.task.update({
      where: { id: taskId },
      data: {
        status: 'COMPLETE',
        completedAt: task.completedAt ?? now,
        consensus: merged?.answer ? (merged.answer as Prisma.InputJsonValue) : Prisma.DbNull,
        agreement: merged?.agreement ?? null,
      },
    });
  }
  if (task.status === 'COMPLETE') {
    return db.task.update({
      where: { id: taskId },
      data: { status: 'OPEN', completedAt: null, consensus: Prisma.DbNull, agreement: null },
    });
  }
  return task;
}
