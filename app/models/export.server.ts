import type { Prisma, Project } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import type { ExportTask } from '~/domain/export';
import { ACCEPTED_STATUSES, finalAnswer } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

export type ExportScope = 'complete' | 'all';

/** Loads tasks with their accepted annotations, ready for the export formats. */
export async function loadExportTasks(project: Project, scope: ExportScope): Promise<ExportTask[]> {
  const where: Prisma.TaskWhereInput = {
    projectId: project.id,
    isQualification: false,
    isGold: false,
    ...(scope === 'complete' ? { status: 'COMPLETE' } : {}),
  };
  const tasks = await prisma.task.findMany({
    where,
    orderBy: { position: 'asc' },
    include: {
      batch: { select: { name: true } },
      assignments: {
        where: { status: 'SUBMITTED', reviewStatus: { in: [...ACCEPTED_STATUSES] } },
        orderBy: { submittedAt: 'asc' },
        include: { user: { select: { email: true } }, reviews: true },
      },
    },
  });
  return tasks.map((task) => ({
    id: task.id,
    externalId: task.externalId,
    batch: task.batch.name,
    data: task.data as Record<string, unknown>,
    status: task.status,
    consensus: task.consensus as Answer | null,
    agreement: task.agreement,
    annotations: task.assignments.map((a) => {
      const scored = a.reviews.filter((r) => r.qaScore !== null);
      return {
        annotator: a.user.email,
        answer: finalAnswer<Answer>(a.answer, a.reviews),
        reviewStatus: a.reviewStatus,
        qaScore: scored.length ? scored[scored.length - 1].qaScore : null,
        activeSeconds: a.activeSeconds,
        submittedAt: a.submittedAt?.toISOString() ?? null,
      };
    }),
  }));
}
