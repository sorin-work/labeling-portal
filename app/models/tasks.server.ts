import { Prisma, type PrismaClient } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import { consensus } from '~/domain/consensus';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { parseTaskSchema } from '~/domain/task-schema';
import { prisma } from '~/lib/db.server';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A task is complete once `overlap` submissions have been accepted; the
 * accepted answers are then merged into a consensus. Called after anything
 * that changes a submission's review state.
 */
export async function refreshTaskStatus(taskId: string, db: Db = prisma, now = new Date()) {
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
