import type { Prisma, PrismaClient } from '@prisma/client';

import { ACCEPTED_STATUSES } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A task is complete once `overlap` submissions have been accepted. Called
 * after anything that changes a submission's review state.
 */
export async function refreshTaskStatus(taskId: string, db: Db = prisma, now = new Date()) {
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    include: { project: { select: { overlap: true } } },
  });
  const accepted = await db.assignment.count({
    where: { taskId, status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
  });
  const complete = accepted >= task.project.overlap;
  if (complete && task.status !== 'COMPLETE') {
    return db.task.update({
      where: { id: taskId },
      data: { status: 'COMPLETE', completedAt: now },
    });
  }
  if (!complete && task.status === 'COMPLETE') {
    return db.task.update({ where: { id: taskId }, data: { status: 'OPEN', completedAt: null } });
  }
  return task;
}
