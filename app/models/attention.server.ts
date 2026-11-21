import { backupAttention, type BackupAttention } from '~/domain/backups';
import { isGoldFlagged } from '~/domain/gold';
import { prisma } from '~/lib/db.server';

const DAY = 24 * 60 * 60 * 1000;

export type AttentionItem =
  | { kind: 'stale-reviews'; projectId: string; projectName: string; count: number }
  | {
      kind: 'low-gold';
      projectId: string;
      projectName: string;
      userName: string;
      accuracy: number;
      attempts: number;
    }
  | BackupAttention;

/** The newest dump that worked, for the line under the admin's list. */
export type LastBackup = { file: string | null; finishedAt: Date } | null;

/**
 * The backup items of the needs-attention list and the newest good dump.
 * `null` when the backup service has never written a row, so a stack that
 * does not run it hears nothing.
 */
export async function backupStatus(
  now = new Date(),
): Promise<{ items: BackupAttention[]; lastGood: LastBackup } | null> {
  const select = {
    finishedAt: true,
    ok: true,
    file: true,
    message: true,
    intervalSeconds: true,
  } as const;
  const [latest, lastGood] = await Promise.all([
    prisma.backupRun.findFirst({ orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], select }),
    prisma.backupRun.findFirst({
      where: { ok: true },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
      select,
    }),
  ]);
  if (!latest) return null;
  return {
    items: backupAttention(latest, lastGood, now),
    lastGood: lastGood ? { file: lastGood.file, finishedAt: lastGood.finishedAt } : null,
  };
}

/**
 * Things a manager should look at across the organisation's active projects:
 * submissions waiting for review for more than a day, and annotators whose
 * gold accuracy is below the pass score. Backups are in `backupStatus`, for
 * admins only.
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
      where: {
        projectId: { in: ids },
        status: 'SUBMITTED',
        goldScore: { not: null },
        task: { isGold: true, goldRetiredAt: null },
      },
      _avg: { goldScore: true },
      _count: { _all: true },
    }),
  ]);

  const lowGold = gold.filter((g) => isGoldFlagged(g._avg.goldScore, g._count._all));
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
