import type { Project } from '@prisma/client';

import { categoricalValue, fleissKappa, pairwiseKappas } from '~/domain/agreement';
import type { Answer } from '~/domain/answers';
import { round } from '~/domain/geometry';
import { GOLD_PASS_SCORE } from '~/domain/gold';
import { finalAnswer } from '~/domain/outcome';
import { prisma } from '~/lib/db.server';

import { projectSchema } from './projects.server';

export type AnnotatorStats = {
  userId: string;
  name: string;
  submitted: number;
  reviewed: number;
  approved: number;
  sentBack: number;
  skipped: number;
  approvalRate: number | null;
  avgQaScore: number | null;
  avgSeconds: number | null;
  tasksPerHour: number | null;
  goldAttempts: number;
  goldAccuracy: number | null;
  /** gold accuracy below the pass score after enough attempts */
  flagged: boolean;
};

const MIN_GOLD_ATTEMPTS = 3;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export async function projectQuality(project: Project) {
  const schema = projectSchema(project);
  const categorical = schema.kind === 'text_classification' || schema.kind === 'pairwise';
  const assignments = await prisma.assignment.findMany({
    where: { projectId: project.id, status: { in: ['SUBMITTED', 'SKIPPED'] } },
    select: {
      userId: true,
      taskId: true,
      status: true,
      skipReason: true,
      activeSeconds: true,
      goldScore: true,
      // answers are only needed to compute kappa for categorical projects
      answer: categorical,
      user: { select: { id: true, name: true } },
      reviews: {
        select: { decision: true, qaScore: true, correctedAnswer: categorical, createdAt: true },
      },
      task: { select: { isGold: true } },
    },
  });

  type Acc = AnnotatorStats & { seconds: number[]; scores: number[]; gold: number[] };
  const byUser = new Map<string, Acc>();
  const skipReasons = new Map<string, number>();
  const ratings = new Map<string, Map<string, string>>();
  const perTask = new Map<string, string[]>();

  for (const a of assignments) {
    const stats =
      byUser.get(a.userId) ??
      ({
        userId: a.userId,
        name: a.user.name,
        submitted: 0,
        reviewed: 0,
        approved: 0,
        sentBack: 0,
        skipped: 0,
        approvalRate: null,
        avgQaScore: null,
        avgSeconds: null,
        tasksPerHour: null,
        goldAttempts: 0,
        goldAccuracy: null,
        flagged: false,
        seconds: [],
        scores: [],
        gold: [],
      } as Acc);
    byUser.set(a.userId, stats);

    if (a.status === 'SKIPPED') {
      stats.skipped += 1;
      // "Other: free text" is grouped under "Other"
      const reason = (a.skipReason ?? 'No reason').split(':')[0];
      skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      continue;
    }
    stats.submitted += 1;
    stats.seconds.push(a.activeSeconds);
    if (a.task.isGold) {
      if (a.goldScore !== null) stats.gold.push(a.goldScore);
      continue;
    }
    for (const review of a.reviews) {
      stats.reviewed += 1;
      if (review.decision === 'APPROVE') stats.approved += 1;
      if (review.decision === 'SEND_BACK') stats.sentBack += 1;
      if (review.qaScore !== null) stats.scores.push(review.qaScore);
    }

    const value =
      categorical && a.answer
        ? categoricalValue(
            schema,
            finalAnswer<Answer>(
              a.answer,
              a.reviews.map((r) => ({ ...r, correctedAnswer: r.correctedAnswer ?? null })),
            ),
          )
        : null;
    if (value !== null) {
      const mine = ratings.get(a.userId) ?? new Map<string, string>();
      mine.set(a.taskId, value);
      ratings.set(a.userId, mine);
      perTask.set(a.taskId, [...(perTask.get(a.taskId) ?? []), value]);
    }
  }

  const annotators: AnnotatorStats[] = [...byUser.values()]
    .map(({ seconds, scores, gold, ...s }) => {
      const totalSeconds = seconds.reduce((sum, v) => sum + v, 0);
      const avgQa = mean(scores);
      const avgSec = mean(seconds);
      const goldMean = mean(gold);
      return {
        ...s,
        goldAttempts: gold.length,
        goldAccuracy: goldMean === null ? null : round(goldMean, 4),
        flagged:
          goldMean !== null && gold.length >= MIN_GOLD_ATTEMPTS && goldMean < GOLD_PASS_SCORE,
        approvalRate: s.reviewed ? round(s.approved / s.reviewed, 4) : null,
        avgQaScore: avgQa === null ? null : round(avgQa, 2),
        avgSeconds: avgSec === null ? null : Math.round(avgSec),
        tasksPerHour: totalSeconds > 0 ? round(s.submitted / (totalSeconds / 3600), 1) : null,
      };
    })
    .sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name));

  const names = new Map(annotators.map((a) => [a.userId, a.name]));
  const pairs = categorical
    ? pairwiseKappas(ratings).map((p) => ({
        ...p,
        a: names.get(p.a) ?? p.a,
        b: names.get(p.b) ?? p.b,
        kappa: p.kappa === null ? null : round(p.kappa, 3),
      }))
    : [];
  const fleiss = categorical ? fleissKappa([...perTask.values()]) : null;

  const completed = await prisma.task.aggregate({
    where: { projectId: project.id, status: 'COMPLETE' },
    _avg: { agreement: true },
    _count: { _all: true },
  });

  return {
    annotators,
    skipReasons: [...skipReasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    agreement: {
      categorical,
      fleiss: fleiss === null ? null : round(fleiss, 3),
      pairs,
      meanTaskAgreement:
        completed._avg.agreement === null ? null : round(completed._avg.agreement, 3),
      completedTasks: completed._count._all,
    },
  };
}

export type DayCount = { day: string; submitted: number; accepted: number };

/** Submissions per UTC day for the last `days` days, oldest first, including empty days. */
export async function dailyThroughput(
  projectId: string,
  days = 14,
  now = new Date(),
): Promise<DayCount[]> {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{ day: Date; submitted: bigint; accepted: bigint }>>`
    SELECT date_trunc('day', a."submittedAt" AT TIME ZONE 'UTC') AS day,
           count(*) AS submitted,
           count(*) FILTER (WHERE a."reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED')) AS accepted
    FROM "Assignment" a
    WHERE a."projectId" = ${projectId}
      AND a.status = 'SUBMITTED'
      AND a."submittedAt" >= ${start} AND a."submittedAt" < ${end}
    GROUP BY 1`;
  const byDay = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), r]));
  const result: DayCount[] = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    result.push({
      day: key,
      submitted: Number(row?.submitted ?? 0),
      accepted: Number(row?.accepted ?? 0),
    });
  }
  return result;
}
