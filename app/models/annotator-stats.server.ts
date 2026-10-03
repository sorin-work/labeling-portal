import { round } from '~/domain/geometry';
import { prisma } from '~/lib/db.server';

const DAY = 24 * 60 * 60 * 1000;

export type MyStats = {
  submitted: number;
  accepted: number;
  sentBack: number;
  acceptanceRate: number | null;
  goldAccuracy: number | null;
  hours: number;
};

/** An annotator's own numbers across all projects for the last `days` days. */
export async function myStats(userId: string, days = 30, now = new Date()): Promise<MyStats> {
  const since = new Date(now.getTime() - days * DAY);
  const where = { userId, status: 'SUBMITTED' as const, submittedAt: { gte: since } };
  const [byStatus, gold, time] = await Promise.all([
    prisma.assignment.groupBy({ by: ['reviewStatus'], where, _count: { _all: true } }),
    prisma.assignment.aggregate({
      where: { ...where, goldScore: { not: null } },
      _avg: { goldScore: true },
    }),
    prisma.assignment.aggregate({ where, _sum: { activeSeconds: true } }),
  ]);
  const count = (statuses: string[]) =>
    byStatus
      .filter((g) => g.reviewStatus && statuses.includes(g.reviewStatus))
      .reduce((s, g) => s + g._count._all, 0);
  const submitted = byStatus.reduce((s, g) => s + g._count._all, 0);
  const accepted = count(['APPROVED', 'FIXED', 'NOT_REQUIRED']);
  const sentBack = count(['SENT_BACK']);
  const decided = accepted + sentBack;
  return {
    submitted,
    accepted,
    sentBack,
    acceptanceRate: decided ? round(accepted / decided, 4) : null,
    goldAccuracy: gold._avg.goldScore === null ? null : round(gold._avg.goldScore, 4),
    hours: round((time._sum.activeSeconds ?? 0) / 3600, 1),
  };
}

export type ReviewerStats = {
  reviews: number;
  sentBack: number;
  fixed: number;
  avgScore: number | null;
};

/** What a reviewer did in the last `days` days. */
export async function reviewerStats(
  userId: string,
  days = 7,
  now = new Date(),
): Promise<ReviewerStats> {
  const since = new Date(now.getTime() - days * DAY);
  const groups = await prisma.review.groupBy({
    by: ['decision'],
    where: { reviewerId: userId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const scores = await prisma.review.aggregate({
    where: { reviewerId: userId, createdAt: { gte: since }, qaScore: { not: null } },
    _avg: { qaScore: true },
  });
  const count = (d: string) => groups.find((g) => g.decision === d)?._count._all ?? 0;
  return {
    reviews: groups.reduce((s, g) => s + g._count._all, 0),
    sentBack: count('SEND_BACK'),
    fixed: count('FIX'),
    avgScore: scores._avg.qaScore === null ? null : round(scores._avg.qaScore, 1),
  };
}
