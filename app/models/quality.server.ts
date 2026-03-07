import type { Project } from '@prisma/client';

import { categoricalValue, fleissKappa, pairwiseKappas } from '~/domain/agreement';
import type { Answer } from '~/domain/answers';
import { round } from '~/domain/geometry';
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
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

export async function projectQuality(project: Project) {
  const schema = projectSchema(project);
  const assignments = await prisma.assignment.findMany({
    where: { projectId: project.id, status: { in: ['SUBMITTED', 'SKIPPED'] } },
    include: { user: { select: { id: true, name: true } }, reviews: true },
  });

  const byUser = new Map<string, AnnotatorStats & { seconds: number[]; scores: number[] }>();
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
        seconds: [],
        scores: [],
      } as AnnotatorStats & { seconds: number[]; scores: number[] });
    byUser.set(a.userId, stats);

    if (a.status === 'SKIPPED') {
      stats.skipped += 1;
      continue;
    }
    stats.submitted += 1;
    stats.seconds.push(a.activeSeconds);
    for (const review of a.reviews) {
      stats.reviewed += 1;
      if (review.decision === 'APPROVE') stats.approved += 1;
      if (review.decision === 'SEND_BACK') stats.sentBack += 1;
      if (review.qaScore !== null) stats.scores.push(review.qaScore);
    }

    const value = a.answer
      ? categoricalValue(schema, finalAnswer<Answer>(a.answer, a.reviews))
      : null;
    if (value !== null) {
      const mine = ratings.get(a.userId) ?? new Map<string, string>();
      mine.set(a.taskId, value);
      ratings.set(a.userId, mine);
      perTask.set(a.taskId, [...(perTask.get(a.taskId) ?? []), value]);
    }
  }

  const annotators: AnnotatorStats[] = [...byUser.values()]
    .map(({ seconds, scores, ...s }) => {
      const totalSeconds = seconds.reduce((sum, v) => sum + v, 0);
      const avgQa = mean(scores);
      const avgSec = mean(seconds);
      return {
        ...s,
        approvalRate: s.reviewed ? round(s.approved / s.reviewed, 4) : null,
        avgQaScore: avgQa === null ? null : round(avgQa, 2),
        avgSeconds: avgSec === null ? null : Math.round(avgSec),
        tasksPerHour: totalSeconds > 0 ? round(s.submitted / (totalSeconds / 3600), 1) : null,
      };
    })
    .sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name));

  const names = new Map(annotators.map((a) => [a.userId, a.name]));
  const categorical = schema.kind === 'text_classification' || schema.kind === 'pairwise';
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
