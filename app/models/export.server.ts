import { createHash } from 'node:crypto';

import type { Prisma, Project } from '@prisma/client';

import { consensusSource } from '~/domain/adjudication';
import type { Answer } from '~/domain/answers';
import type { ExportTask } from '~/domain/export';
import { ACCEPTED_STATUSES, finalAnswer, standingReviews } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

export type ExportScope = 'complete' | 'all';

export type ExportOptions = {
  scope: ExportScope;
  batchId?: string | null;
  /**
   * How an annotation names its annotator: a pseudonym that is stable within
   * the project, or the email address. A pseudonym does not need the address,
   * so it is not read at all.
   */
  annotators: 'pseudonym' | 'email';
  /** "labels" formats only use the answers; the rest is not read for them */
  needs: 'annotations' | 'labels';
};

/** Tasks are read this many at a time, so memory does not grow with the project. */
const PAGE = 200;

/**
 * A name for an annotator that says nothing about the person and is the same
 * in every export of the project: exports get passed around. It differs from
 * project to project, so two exports cannot be joined on it.
 */
export function pseudonym(projectId: string, userId: string): string {
  const hash = createHash('sha256').update(`${projectId}:${userId}`).digest('hex');
  return `ann_${hash.slice(0, 8)}`;
}

/** Which tasks an export holds: never gold or qualification tasks, never another project's. */
export function exportWhere(
  projectId: string,
  scope: ExportScope,
  batchId?: string | null,
): Prisma.TaskWhereInput {
  return {
    projectId,
    ...(batchId ? { batchId } : {}),
    isQualification: false,
    isGold: false,
    ...(scope === 'complete' ? { status: 'COMPLETE' } : {}),
  };
}

export function countExportTasks(project: Project, scope: ExportScope, batchId?: string | null) {
  return prisma.task.count({ where: exportWhere(project.id, scope, batchId) });
}

type Cursor = { position: number; id: string };

/** One page of tasks after `cursor`, with only the columns an export uses. */
function exportPage(
  where: Prisma.TaskWhereInput,
  cursor: Cursor | null,
  detailed: boolean,
  withEmail: boolean,
) {
  return prisma.task.findMany({
    where: cursor
      ? {
          AND: [
            where,
            {
              OR: [
                { position: { gt: cursor.position } },
                { position: cursor.position, id: { gt: cursor.id } },
              ],
            },
          ],
        }
      : where,
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    take: PAGE,
    select: {
      id: true,
      externalId: true,
      position: true,
      data: true,
      status: true,
      consensus: true,
      adjudicatedAt: true,
      agreement: true,
      suggestion: true,
      suggestionSource: true,
      batch: { select: { name: true } },
      assignments: {
        where: { status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        select: {
          answer: true,
          userId: true,
          reviewStatus: detailed,
          activeSeconds: detailed,
          submittedAt: detailed,
          fromSuggestion: detailed,
          suggestionUnchanged: detailed,
          user: withEmail ? { select: { email: true } } : false,
          reviews: {
            orderBy: { createdAt: 'asc' },
            select: {
              decision: true,
              correctedAnswer: true,
              createdAt: true,
              overturnedAt: true,
              qaScore: detailed,
            },
          },
        },
      },
    },
  });
}

/**
 * The tasks of an export with their accepted annotations, one at a time, in
 * import order. They are read in pages by position, and only the columns an
 * export uses are selected: an assignment's draft, its frozen rate and its
 * pay dates are never read here.
 */
export async function* exportTasks(
  project: Project,
  options: ExportOptions,
): AsyncGenerator<ExportTask> {
  const detailed = options.needs === 'annotations';
  const withEmail = detailed && options.annotators === 'email';
  const where = exportWhere(project.id, options.scope, options.batchId);
  let cursor: Cursor | null = null;
  for (;;) {
    const tasks: Awaited<ReturnType<typeof exportPage>> = await exportPage(
      where,
      cursor,
      detailed,
      withEmail,
    );
    for (const task of tasks) {
      yield {
        id: task.id,
        externalId: task.externalId,
        batch: task.batch.name,
        data: task.data as Record<string, unknown>,
        status: task.status,
        consensus: task.consensus as Answer | null,
        consensusSource: consensusSource(task),
        agreement: task.agreement,
        suggestion:
          task.suggestion === null
            ? null
            : { answer: task.suggestion as Answer, source: task.suggestionSource ?? 'file' },
        annotations: task.assignments.map((a) => {
          // the score of the last review that gave one and was not overturned
          const scored = standingReviews(a.reviews).filter((r) => r.qaScore != null);
          return {
            annotator: a.user?.email ?? pseudonym(project.id, a.userId),
            answer: finalAnswer<Answer>(a.answer, a.reviews),
            reviewStatus: a.reviewStatus ?? null,
            qaScore: scored.length ? (scored[scored.length - 1].qaScore ?? null) : null,
            activeSeconds: a.activeSeconds ?? 0,
            submittedAt: a.submittedAt?.toISOString() ?? null,
            fromSuggestion: a.fromSuggestion ?? false,
            suggestionUnchanged: a.suggestionUnchanged ?? null,
          };
        }),
      };
    }
    if (tasks.length < PAGE) return;
    const last: Cursor = tasks[tasks.length - 1];
    cursor = { position: last.position, id: last.id };
  }
}
