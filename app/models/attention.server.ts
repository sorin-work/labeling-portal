import { GOLD_PASS_SCORE } from '~/domain/gold';
import { prisma } from '~/lib/db.server';

const DAY = 24 * 60 * 60 * 1000;
const MIN_GOLD_ATTEMPTS = 3;

export type AttentionItem =
  | { kind: 'stale-reviews'; projectId: string; projectName: string; count: number }
  | {
      kind: 'low-gold';
      projectId: string;
      projectName: string;
      userName: string;
      accuracy: number;
      attempts: number;
    };

/**
 * Things a manager should look at across the organisation's active projects:
 * submissions waiting for review for more than a day, and annotators whose
 * gold accuracy is below the pass score.
 */
export async function needsAttention(orgId: string, now = new Date()): Promise<AttentionItem[]> {
  const projects = await prisma.project.findMany({
    where: { orgId, status: 'ACTIVE' },
    select: { id: true, name: true },
  });
  if (projects.length === 0) return [];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const ids = projects.map((p) => p.id);

  const [stale, gold] = await Promise.all([
    prisma.assignment.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: ids },
        status: 'SUBMITTED',
        reviewStatus: 'PENDING',
        submittedAt: { lt: new Date(now.getTime() - DAY) },
      },
      _count: { _all: true },
    }),
    prisma.assignment.groupBy({
      by: ['projectId', 'userId'],
      where: { projectId: { in: ids }, status: 'SUBMITTED', goldScore: { not: null } },
      _avg: { goldScore: true },
      _count: { _all: true },
    }),
  ]);

  const lowGold = gold.filter(
    (g) => g._count._all >= MIN_GOLD_ATTEMPTS && (g._avg.goldScore ?? 1) < GOLD_PASS_SCORE,
  );
  const users = await prisma.user.findMany({
    where: { id: { in: lowGold.map((g) => g.userId) } },
    select: { id: true, name: true },
  });
  const userNames = new Map(users.map((u) => [u.id, u.name]));

  return [
    ...stale.map((s) => ({
      kind: 'stale-reviews' as const,
      projectId: s.projectId,
      projectName: names.get(s.projectId) ?? '',
      count: s._count._all,
    })),
    ...lowGold.map((g) => ({
      kind: 'low-gold' as const,
      projectId: g.projectId,
      projectName: names.get(g.projectId) ?? '',
      userName: userNames.get(g.userId) ?? '',
      accuracy: Math.round((g._avg.goldScore ?? 0) * 100) / 100,
      attempts: g._count._all,
    })),
  ];
}
