import type { Batch, Prisma } from '@prisma/client';

import type { ImportFormat, ImportRow } from '~/domain/import';
import { diffSchema } from '~/domain/schema-diff';
import { parseTaskSchema, type TaskSchema } from '~/domain/task-schema';
import { prisma } from '~/lib/db.server';

export type CreateBatchResult = { ok: true; batch: Batch } | { ok: false; error: 'schema_changed' };

/**
 * Creates a batch and its tasks, all of them or none. Task positions continue
 * after the project's last task.
 *
 * `schema` is the one the rows, and their gold answers, were validated
 * against. The project row is held while the tasks are written, and the batch
 * is refused when the saved schema is no longer that one. A settings save
 * asks for a stronger lock on the same row, so it either waits for this import
 * and then counts its gold answers, or it was first, and then the file has to
 * be read again against the new schema.
 */
export async function createBatch(
  projectId: string,
  input: {
    name: string;
    format: ImportFormat;
    rows: ImportRow[];
    qualification?: boolean;
    schema: TaskSchema;
  },
): Promise<CreateBatchResult> {
  return prisma.$transaction(async (tx) => {
    const [project] = await tx.$queryRaw<Array<{ schema: unknown }>>`
      SELECT schema FROM "Project" WHERE id = ${projectId} FOR SHARE`;
    const saved = parseTaskSchema(project?.schema);
    if (!saved.ok || diffSchema(saved.schema, input.schema).length > 0) {
      return { ok: false, error: 'schema_changed' };
    }

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
        isGold: row.gold !== undefined && !input.qualification,
        isQualification: input.qualification ?? false,
        goldAnswer: row.gold === undefined ? undefined : (row.gold as Prisma.InputJsonValue),
      })),
    });
    return { ok: true, batch };
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

export type DeleteBatchResult = { ok: true; tasks: number } | { ok: false; error: string };

/**
 * Removes a batch and its tasks. Only allowed while nobody has submitted or
 * skipped any of its tasks, so no paid or reviewed work is lost.
 */
export async function deleteBatch(projectId: string, batchId: string): Promise<DeleteBatchResult> {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({ where: { id: batchId, projectId } });
    if (!batch) return { ok: false, error: 'Batch not found.' };
    const worked = await tx.assignment.count({
      where: { task: { batchId }, status: { in: ['SUBMITTED', 'SKIPPED'] } },
    });
    if (worked > 0) {
      return { ok: false, error: 'Tasks in this batch already have work on them.' };
    }
    const tasks = await tx.task.count({ where: { batchId } });
    await tx.batch.delete({ where: { id: batchId } });
    return { ok: true, tasks };
  });
}
