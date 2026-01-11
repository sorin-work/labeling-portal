import type { Prisma } from '@prisma/client';

import type { ImportFormat, ImportRow } from '~/domain/import';
import { prisma } from '~/lib/db.server';

/** Creates a batch and its tasks. Task positions continue after the project's last task. */
export async function createBatch(
  projectId: string,
  input: { name: string; format: ImportFormat; rows: ImportRow[] },
) {
  return prisma.$transaction(async (tx) => {
    const last = await tx.task.aggregate({ where: { projectId }, _max: { position: true } });
    const start = (last._max.position ?? 0) + 1;
    const batch = await tx.batch.create({
      data: { projectId, name: input.name, format: input.format },
    });
    await tx.task.createMany({
      data: input.rows.map((row, i) => ({
        projectId,
        batchId: batch.id,
        externalId: row.externalId,
        position: start + i,
        data: row.data as Prisma.InputJsonValue,
      })),
    });
    return batch;
  });
}

export async function listBatches(projectId: string) {
  const [batches, counts] = await Promise.all([
    prisma.batch.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.task.groupBy({
      by: ['batchId', 'status'],
      where: { projectId },
      _count: { _all: true },
    }),
  ]);
  return batches.map((batch) => {
    const mine = counts.filter((c) => c.batchId === batch.id);
    const total = mine.reduce((sum, c) => sum + c._count._all, 0);
    const complete = mine.find((c) => c.status === 'COMPLETE')?._count._all ?? 0;
    return { ...batch, total, complete };
  });
}
