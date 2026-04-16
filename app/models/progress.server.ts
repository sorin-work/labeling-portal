import { prisma } from '~/lib/db.server';

export type ProjectProgress = {
  tasks: number;
  complete: number;
  gold: number;
  pendingReview: number;
  activeClaims: number;
  skipped: number;
};

/** Counts for the project overview. Gold and qualification tasks are counted separately. */
export async function projectProgress(
  projectId: string,
  now = new Date(),
): Promise<ProjectProgress> {
  const regular = { projectId, isGold: false, isQualification: false };
  const [tasks, complete, gold, pendingReview, activeClaims, skipped] = await Promise.all([
    prisma.task.count({ where: regular }),
    prisma.task.count({ where: { ...regular, status: 'COMPLETE' } }),
    prisma.task.count({ where: { projectId, isGold: true } }),
    prisma.assignment.count({ where: { projectId, status: 'SUBMITTED', reviewStatus: 'PENDING' } }),
    prisma.assignment.count({ where: { projectId, status: 'ACTIVE', expiresAt: { gt: now } } }),
    prisma.assignment.count({ where: { projectId, status: 'SKIPPED' } }),
  ]);
  return { tasks, complete, gold, pendingReview, activeClaims, skipped };
}
