import { Prisma, type Project } from '@prisma/client';

import { categoricalValue, fleissKappa, isCategorical, pairwiseKappas } from '~/domain/agreement';
import type { Answer } from '~/domain/answers';
import { round } from '~/domain/geometry';
import { isGoldFlagged } from '~/domain/gold';
import { finalAnswer, standingReviews } from '~/domain/outcome';
import { prisma, utc } from '~/lib/db.server';

import { projectSchema } from './projects.server';

export type AnnotatorStats = {
  userId: string;
  name: string;
  submitted: number;
  /** review decisions on their work; sent-back work can have several */
  reviewed: number;
  /** submissions a reviewer could look at, so gold tasks are left out */
  reviewable: number;
  /** how many of those a reviewer has decided on */
  reviewedSubmissions: number;
  /** the part of their work the approval rate is based on */
  reviewedShare: number | null;
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
  /**
   * spot checks of accepted work that no reviewer had seen; picked rather
   * than drawn, so they are counted here and nowhere else
   */
  spotChecks: number;
  /** of those, how many the reviewer would have sent back */
  spotCheckSendBacks: number;
};

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

type QualityReview = {
  decision: string;
  qaScore: number | null;
  correctedAnswer: unknown;
  createdAt: Date;
  overturnedAt: Date | null;
  spotCheck: boolean;
};

type QualityRow = {
  id: string;
  userId: string;
  taskId: string;
  status: 'SUBMITTED' | 'SKIPPED';
  skipReason: string | null;
  activeSeconds: number;
  goldScore: number | null;
  answer: unknown;
  user: { id: string; name: string };
  task: { isGold: boolean; goldRetiredAt: Date | null };
  reviews: QualityReview[];
};

/**
 * The submitted and skipped assignments of a project with what the quality
 * page needs of them, in two statements: the assignments joined to their
 * annotator and task, then the reviews of those assignments. Answers (and
 * corrected answers) are only read for categorical projects, where kappa
 * needs them. A project with hundreds of thousands of answers is read in a
 * few seconds this way, where loading the same rows as nested relations took
 * minutes.
 */
async function loadQualityRows(projectId: string, categorical: boolean): Promise<QualityRow[]> {
  const answer = categorical ? Prisma.sql`a.answer` : Prisma.sql`NULL::jsonb`;
  const corrected = categorical ? Prisma.sql`r."correctedAnswer"` : Prisma.sql`NULL::jsonb`;
  const [rows, reviews] = await Promise.all([
    prisma.$queryRaw<
      Array<
        Omit<QualityRow, 'user' | 'task' | 'reviews'> & {
          name: string;
          isGold: boolean;
          goldRetiredAt: Date | null;
        }
      >
    >`
      SELECT a.id, a."userId", a."taskId", a.status::text AS status, a."skipReason",
             a."activeSeconds", a."goldScore", ${answer} AS answer,
             u.name, t."isGold", t."goldRetiredAt"
      FROM "Assignment" a
      JOIN "User" u ON u.id = a."userId"
      JOIN "Task" t ON t.id = a."taskId"
      WHERE a."projectId" = ${projectId} AND a.status IN ('SUBMITTED', 'SKIPPED')`,
    prisma.$queryRaw<Array<QualityReview & { assignmentId: string }>>`
      SELECT r."assignmentId", r.decision::text AS decision, r."qaScore",
             ${corrected} AS "correctedAnswer", r."createdAt", r."overturnedAt",
             r."spotCheck"
      FROM "Review" r
      JOIN "Assignment" a ON a.id = r."assignmentId"
      WHERE a."projectId" = ${projectId} AND a.status IN ('SUBMITTED', 'SKIPPED')`,
  ]);
  const byAssignment = new Map<string, QualityReview[]>();
  for (const { assignmentId, ...review } of reviews) {
    const list = byAssignment.get(assignmentId);
    if (list) list.push(review);
    else byAssignment.set(assignmentId, [review]);
  }
  return rows.map(({ name, isGold, goldRetiredAt, ...a }) => ({
    ...a,
    user: { id: a.userId, name },
    task: { isGold, goldRetiredAt },
    reviews: byAssignment.get(a.id) ?? [],
  }));
}

export async function projectQuality(project: Project) {
  const schema = projectSchema(project);
  const categorical = isCategorical(schema);
  const assignments = await loadQualityRows(project.id, categorical);

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
        reviewable: 0,
        reviewedSubmissions: 0,
        reviewedShare: null,
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
        spotChecks: 0,
        spotCheckSendBacks: 0,
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
      // the score on a retired gold task is kept but counts for nobody
      if (a.goldScore !== null && !a.task.goldRetiredAt) stats.gold.push(a.goldScore);
      continue;
    }
    // A spot check is picked, not drawn, so it leans towards bad work: it has
    // a column of its own and stays out of the reviewed share, the approval
    // rate and the QA average.
    for (const check of a.reviews.filter((r) => r.spotCheck)) {
      stats.spotChecks += 1;
      if (check.decision === 'SEND_BACK') stats.spotCheckSendBacks += 1;
    }
    // a decision that a dispute overturned no longer counts for or against anyone
    const standing = standingReviews(a.reviews.filter((r) => !r.spotCheck));
    stats.reviewable += 1;
    if (standing.length > 0) stats.reviewedSubmissions += 1;
    for (const review of standing) {
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
        flagged: isGoldFlagged(goldMean, gold.length),
        reviewedShare: s.reviewable ? round(s.reviewedSubmissions / s.reviewable, 4) : null,
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

  const [completed, adjudicated, waiting] = await Promise.all([
    prisma.task.aggregate({
      where: { projectId: project.id, status: 'COMPLETE' },
      _avg: { agreement: true },
      _count: { _all: true },
    }),
    prisma.task.count({
      where: { projectId: project.id, status: 'COMPLETE', adjudicatedAt: { not: null } },
    }),
    prisma.task.count({ where: { projectId: project.id, status: 'ADJUDICATION' } }),
  ]);

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
      // how the completed tasks got their result: from the answers, or settled by a reviewer
      adjudicatedTasks: adjudicated,
      majorityTasks: completed._count._all - adjudicated,
      waitingAdjudication: waiting,
    },
  };
}

/**
 * Whether the annotator is flagged in the project right now, by the same rule
 * as the `flagged` column above. Sampling sends all work of a flagged
 * annotator to review.
 */
export async function isAnnotatorFlagged(projectId: string, userId: string): Promise<boolean> {
  const gold = await prisma.assignment.aggregate({
    where: {
      projectId,
      userId,
      status: 'SUBMITTED',
      goldScore: { not: null },
      task: { isGold: true, goldRetiredAt: null },
    },
    _avg: { goldScore: true },
    _count: { _all: true },
  });
  return isGoldFlagged(gold._avg.goldScore, gold._count._all);
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
    SELECT date_trunc('day', a."submittedAt") AS day,
           count(*) AS submitted,
           count(*) FILTER (WHERE a."reviewStatus" IN ('APPROVED', 'FIXED', 'NOT_REQUIRED')) AS accepted
    FROM "Assignment" a
    WHERE a."projectId" = ${projectId}
      AND a.status = 'SUBMITTED'
      AND a."submittedAt" >= ${utc(start)} AND a."submittedAt" < ${utc(end)}
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
