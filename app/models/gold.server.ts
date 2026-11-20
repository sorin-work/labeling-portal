import { createHash } from 'node:crypto';

import { Prisma, type Project } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import {
  describeGoldAnswer,
  goldImpact,
  parseGold,
  rescore,
  sameAnswer,
  scoreAgainstGold,
  type GoldImpact,
  type ScoreChange,
} from '~/domain/gold';
import { taskPreview } from '~/domain/preview';
import { parseTaskSchema } from '~/domain/task-schema';
import { prisma } from '~/lib/db.server';

import { projectSchema } from './projects.server';

type Tx = Prisma.TransactionClient;
type Db = typeof prisma | Tx;

/** Gold submissions whose score counts: submitted, scored, on a gold task that is not retired. */
const counted = (projectId: string) =>
  ({
    projectId,
    status: 'SUBMITTED',
    goldScore: { not: null },
    task: { isGold: true, goldRetiredAt: null },
  }) satisfies Prisma.AssignmentWhereInput;

/**
 * Locks a task of the project for the rest of the transaction. Everything
 * that changes a gold task starts here, and a submission scores itself under
 * a shared lock on the same row (`scoreGoldSubmission`), so an edit, a
 * rescore and a new submission never interleave.
 */
async function lockTask(tx: Tx, projectId: string, taskId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Task" WHERE id = ${taskId} AND "projectId" = ${projectId} FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/**
 * Scores a submission against the expected answer of its gold task, inside
 * the transaction that stores the submission. The expected answer is read
 * under a shared lock: a manager's edit either lands first and is used here,
 * or waits until this submission is stored and is then picked up by a
 * rescore. Annotators submitting at the same time do not block each other.
 */
export async function scoreGoldSubmission(
  tx: Tx,
  taskId: string,
  schemaJson: unknown,
  answer: unknown,
): Promise<number | null> {
  const [task] = await tx.$queryRaw<Array<{ goldAnswer: unknown }>>`
    SELECT "goldAnswer" FROM "Task" WHERE id = ${taskId} FOR SHARE`;
  const schema = parseTaskSchema(schemaJson);
  if (!task?.goldAnswer || !schema.ok) return null;
  return scoreAgainstGold(schema.schema, answer as Answer, task.goldAnswer as Answer);
}

export type GoldRefusal =
  | { error: 'not_found' | 'not_gold' | 'unchanged' | 'already_done' | 'another_live' }
  | { error: 'invalid'; message: string };

type GoldResult = { ok: true } | ({ ok: false } & GoldRefusal);

/**
 * Replaces the expected answer of a gold task or a qualification question.
 * The answer goes through the same validation as an imported gold answer for
 * the project's schema as it is now. The old answer, who changed it, when
 * and why are kept as a `GoldRevision`. Scores already given are left alone:
 * rescoring is its own step (`applyRescore`).
 */
export async function editGoldAnswer(
  project: Project,
  taskId: string,
  actorId: string,
  input: { answer: unknown; reason: string },
  now = new Date(),
): Promise<GoldResult> {
  const schema = projectSchema(project);
  return prisma.$transaction(async (tx) => {
    if (!(await lockTask(tx, project.id, taskId))) return { ok: false, error: 'not_found' };
    const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
    if (!task.goldAnswer || !(task.isGold || task.isQualification)) {
      return { ok: false, error: 'not_gold' };
    }
    const parsed = parseGold(schema, task.data as Record<string, unknown>, input.answer);
    if (!parsed.ok) return { ok: false, error: 'invalid', message: parsed.error };
    if (sameAnswer(parsed.answer, task.goldAnswer)) return { ok: false, error: 'unchanged' };

    const answer = parsed.answer as Prisma.InputJsonValue;
    await tx.task.update({ where: { id: taskId }, data: { goldAnswer: answer } });
    await tx.goldRevision.create({
      data: {
        taskId,
        change: 'EDITED',
        previousAnswer: task.goldAnswer,
        answer,
        reason: input.reason,
        changedById: actorId,
        createdAt: now,
      },
    });
    await tx.activity.create({
      data: {
        projectId: project.id,
        actorId,
        action: 'gold.edited',
        detail: {
          taskId,
          position: task.position,
          from: describeGoldAnswer(schema, task.goldAnswer),
          to: describeGoldAnswer(schema, parsed.answer),
          reason: input.reason,
        },
        createdAt: now,
      },
    });
    return { ok: true };
  });
}

/**
 * Retires a gold task or brings it back. A retired task is not handed out
 * and its scores do not count for anyone; the scores themselves are kept, so
 * bringing it back restores them. The write requires the state it expects,
 * so two managers doing the same thing at once leave one history entry.
 */
export async function setGoldRetired(
  project: Project,
  taskId: string,
  actorId: string,
  input: { retired: boolean; reason: string },
  now = new Date(),
): Promise<GoldResult> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockTask(tx, project.id, taskId))) return { ok: false, error: 'not_found' };
    if (!input.retired) {
      // An original has at most one live copy, or someone could be handed the
      // same item twice. Promoting a task locks the original too, so the
      // check below and a new copy cannot pass each other.
      const { goldSourceId } = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      if (goldSourceId) {
        await lockTask(tx, project.id, goldSourceId);
        const live = await tx.task.count({
          where: { goldSourceId, goldRetiredAt: null, id: { not: taskId } },
        });
        if (live > 0) return { ok: false, error: 'another_live' };
      }
    }
    const changed = await tx.task.updateManyAndReturn({
      where: {
        id: taskId,
        isGold: true,
        goldRetiredAt: input.retired ? null : { not: null },
      },
      data: { goldRetiredAt: input.retired ? now : null },
      select: { position: true },
    });
    if (changed.length === 0) {
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      return { ok: false, error: task.isGold ? 'already_done' : 'not_gold' };
    }
    await tx.goldRevision.create({
      data: {
        taskId,
        change: input.retired ? 'RETIRED' : 'RESTORED',
        reason: input.reason,
        changedById: actorId,
        createdAt: now,
      },
    });
    await tx.activity.create({
      data: {
        projectId: project.id,
        actorId,
        action: input.retired ? 'gold.retired' : 'gold.restored',
        detail: { taskId, position: changed[0].position, reason: input.reason },
        createdAt: now,
      },
    });
    return { ok: true };
  });
}

/** The scores that count for each of these annotators in the project, by submission. */
async function countedScores(db: Db, projectId: string, userIds: string[]) {
  const rows = await db.assignment.findMany({
    where: { ...counted(projectId), userId: { in: userIds } },
    select: { id: true, userId: true, taskId: true, goldScore: true },
  });
  return rows.map((r) => ({ ...r, goldScore: r.goldScore ?? 0 }));
}

function byAnnotator<T extends { userId: string }>(rows: T[], score: (row: T) => number) {
  const map = new Map<string, number[]>();
  for (const row of rows) map.set(row.userId, [...(map.get(row.userId) ?? []), score(row)]);
  return map;
}

export type RescorePlan = {
  /** submissions of the task that have a stored answer */
  submissions: number;
  /** the scores that would change, or did */
  changes: ScoreChange[];
  /** what that does to the annotators' gold accuracy and flags */
  impact: GoldImpact;
  /**
   * Stands for exactly this plan: the expected answer, every score change and
   * every annotator's standing before and after. The page sends it back with
   * "Rescore", and the rescore is refused when it would do something else.
   */
  digest: string;
};

function planDigest(gold: unknown, changes: ScoreChange[], impact: GoldImpact): string {
  const byId = <T>(rows: T[], id: (row: T) => string) =>
    [...rows].sort((a, b) => id(a).localeCompare(id(b)));
  const canonical = JSON.stringify([
    describeForDigest(gold),
    byId(changes, (c) => c.assignmentId).map((c) => [c.assignmentId, c.from, c.to]),
    byId(impact.moved, (m) => m.userId).map((m) => [
      m.userId,
      m.before.attempts,
      m.before.accuracy,
      m.before.flagged,
      m.after.attempts,
      m.after.accuracy,
      m.after.flagged,
    ]),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** JSON with its keys in order, so the same answer always gives the same text. */
function describeForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(describeForDigest);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .map((key) => [key, describeForDigest((value as Record<string, unknown>)[key])]);
  }
  return value;
}

/**
 * Works out what rescoring a gold task changes, without changing anything:
 * every stored answer is scored against the expected answer as it is now.
 */
async function planRescore(db: Db, project: Project, taskId: string): Promise<RescorePlan | null> {
  const task = await db.task.findFirst({ where: { id: taskId, projectId: project.id } });
  if (!task?.isGold || !task.goldAnswer) return null;
  const submissions = await db.assignment.findMany({
    where: { taskId, status: 'SUBMITTED' },
    select: { id: true, userId: true, answer: true, goldScore: true },
  });
  const changes = rescore(
    projectSchema(project),
    task.goldAnswer as Answer,
    submissions.map((s) => ({ ...s, assignmentId: s.id })),
  );

  // A retired task counts for nobody, so rescoring it moves no annotator.
  const users = [...new Set(changes.map((c) => c.userId))];
  const before = await countedScores(db, project.id, users);
  const next = new Map(changes.map((c) => [c.assignmentId, c.to]));
  const after = task.goldRetiredAt
    ? before
    : [
        ...before.map((row) => ({ ...row, goldScore: next.get(row.id) ?? row.goldScore })),
        // answers that had no score yet start to count
        ...changes
          .filter((c) => c.from === null)
          .map((c) => ({ id: c.assignmentId, userId: c.userId, taskId, goldScore: c.to })),
      ];
  const impact = goldImpact(
    byAnnotator(before, (r) => r.goldScore),
    byAnnotator(after, (r) => r.goldScore),
  );
  return {
    submissions: submissions.filter((s) => s.answer !== null).length,
    changes,
    impact,
    digest: planDigest(task.goldAnswer, changes, impact),
  };
}

/** What a rescore of the task would change. Reads only. */
export function previewRescore(project: Project, taskId: string) {
  return planRescore(prisma, project, taskId);
}

/**
 * Rescores every submission of a gold task against its expected answer as it
 * is now, in one transaction, and returns what changed. It recomputes from
 * the stored answers, so running it again changes nothing. Only `goldScore`
 * is written: the work stays accepted and paid as it was.
 *
 * `previewed` is the digest of the plan the manager looked at. The plan is
 * worked out again under the lock, and if it is not the same one (the
 * expected answer was edited again, a submission arrived, another task was
 * rescored) nothing is written and the new plan comes back to be shown.
 */
export async function applyRescore(
  project: Project,
  taskId: string,
  actorId: string,
  previewed: string,
  now = new Date(),
): Promise<
  | { ok: true; plan: RescorePlan }
  | { ok: false; error: 'not_found' | 'not_gold' }
  | { ok: false; error: 'stale'; plan: RescorePlan }
> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockTask(tx, project.id, taskId))) return { ok: false, error: 'not_found' };
    const plan = await planRescore(tx, project, taskId);
    if (!plan) return { ok: false, error: 'not_gold' };
    if (plan.digest !== previewed) return { ok: false, error: 'stale', plan };
    for (const change of plan.changes) {
      await tx.assignment.update({
        where: { id: change.assignmentId },
        data: { goldScore: change.to },
      });
    }
    if (plan.changes.length > 0) {
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await tx.activity.create({
        data: {
          projectId: project.id,
          actorId,
          action: 'gold.rescored',
          detail: {
            taskId,
            position: task.position,
            scores: plan.changes.length,
            annotators: plan.impact.moved.length,
            newlyFlagged: plan.impact.newlyFlagged,
            noLongerFlagged: plan.impact.noLongerFlagged,
          },
          createdAt: now,
        },
      });
    }
    return { ok: true, plan };
  });
}

/**
 * What retiring a gold task (or bringing a retired one back) does to the
 * annotators who answered it: their scores on it stop or start to count.
 */
export async function previewRetire(project: Project, taskId: string): Promise<GoldImpact | null> {
  const task = await prisma.task.findFirst({ where: { id: taskId, projectId: project.id } });
  if (!task?.isGold) return null;
  const own = await prisma.assignment.findMany({
    where: { taskId, status: 'SUBMITTED', goldScore: { not: null } },
    select: { id: true, userId: true, taskId: true, goldScore: true },
  });
  const users = [...new Set(own.map((s) => s.userId))];
  const others = (await countedScores(prisma, project.id, users)).filter(
    (row) => row.taskId !== taskId,
  );
  const withTask = [...others, ...own.map((s) => ({ ...s, goldScore: s.goldScore ?? 0 }))];
  const [before, after] = task.goldRetiredAt ? [others, withTask] : [withTask, others];
  return goldImpact(
    byAnnotator(before, (r) => r.goldScore),
    byAnnotator(after, (r) => r.goldScore),
  );
}

export type PromoteOutcome = {
  created: string[];
  skipped: Array<{ taskId: string; why: string }>;
  /** set when nothing could be made at all */
  refused?: string;
};

const openRegular = { status: 'OPEN', isGold: false, isQualification: false } as const;

/**
 * The batches a new gold task can go into: those that still have open tasks
 * and are not paused, the most recently imported first. A gold task in a
 * batch that is otherwise finished would be the only task an annotator still
 * gets from it.
 */
export function openBatches(projectId: string, db: Db = prisma) {
  return db.batch.findMany({
    where: { projectId, pausedAt: null, tasks: { some: openRegular } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, name: true },
  });
}

/**
 * Makes gold tasks out of completed tasks: for each one a copy with the same
 * data whose expected answer is the consensus. The original is left alone,
 * because its labels are real data and gold tasks are left out of the export.
 *
 * The consensus goes through the same validation as an imported gold answer,
 * against the project's schema as it is now.
 *
 * A copy must look like any other task to the annotator who gets it. So it
 * goes into a batch that still has open tasks (the one chosen, or the most
 * recent), at the position of one of that batch's open tasks picked at
 * random, and it does not take the original's external id. An original has
 * at most one live copy.
 */
export async function promoteToGold(
  project: Project,
  taskIds: string[],
  actorId: string,
  options: { batchId?: string | null; random?: () => number; now?: Date } = {},
): Promise<PromoteOutcome> {
  const { random = Math.random, now = new Date() } = options;
  const schema = projectSchema(project);
  const ids = [...new Set(taskIds)];
  if (ids.length === 0) return { created: [], skipped: [] };
  return prisma.$transaction(async (tx) => {
    // two managers promoting the same task wait for each other here, and so
    // does bringing back a retired copy of one of them
    await tx.$queryRaw`
      SELECT id FROM "Task"
      WHERE id IN (${Prisma.join(ids)}) AND "projectId" = ${project.id}
      ORDER BY id FOR NO KEY UPDATE`;

    const batches = await openBatches(project.id, tx);
    const batch = options.batchId ? batches.find((b) => b.id === options.batchId) : batches.at(0);
    if (!batch) {
      return {
        created: [],
        skipped: [],
        refused: options.batchId
          ? 'the chosen batch has no open tasks left to put a gold task among'
          : 'no batch has open tasks to put a gold task among; import tasks first',
      };
    }
    const sources = await tx.task.findMany({
      where: { id: { in: ids }, projectId: project.id },
      include: { goldCopies: { where: { goldRetiredAt: null }, select: { id: true } } },
    });
    const open = await tx.task.findMany({
      where: { batchId: batch.id, ...openRegular },
      orderBy: { position: 'asc' },
      select: { position: true },
    });

    const outcome: PromoteOutcome = { created: [], skipped: [] };
    for (const id of ids) {
      const source = sources.find((s) => s.id === id);
      const skip = (why: string) => outcome.skipped.push({ taskId: id, why });
      if (!source) {
        skip('not a task of this project');
        continue;
      }
      if (source.isGold || source.isQualification) {
        skip('already a gold task or a qualification question');
        continue;
      }
      if (source.status !== 'COMPLETE' || !source.consensus) {
        skip('not complete, or without a consensus');
        continue;
      }
      if (source.goldCopies.length > 0) {
        skip('already used as gold');
        continue;
      }
      const data = source.data as Record<string, unknown>;
      const parsed = parseGold(schema, data, source.consensus);
      if (!parsed.ok) {
        skip(`its consensus is not a valid answer any more: ${parsed.error}`);
        continue;
      }
      const answer = parsed.answer as Prisma.InputJsonValue;
      const slot = open[Math.min(open.length - 1, Math.floor(random() * open.length))];
      const copy = await tx.task.create({
        data: {
          projectId: project.id,
          batchId: batch.id,
          position: slot.position,
          data: source.data as Prisma.InputJsonValue,
          isGold: true,
          goldAnswer: answer,
          goldSourceId: source.id,
          createdAt: now,
        },
      });
      await tx.goldRevision.create({
        data: {
          taskId: copy.id,
          change: 'CREATED',
          answer,
          reason: `Copied from the consensus of task #${source.position}`,
          changedById: actorId,
          createdAt: now,
        },
      });
      outcome.created.push(copy.id);
    }
    if (outcome.created.length > 0) {
      await tx.activity.create({
        data: {
          projectId: project.id,
          actorId,
          action: 'gold.created',
          detail: { tasks: outcome.created.length, batch: batch.name },
          createdAt: now,
        },
      });
    }
    return outcome;
  });
}

/** Everything the task page shows a manager about a gold task or a qualification question. */
export async function goldTaskView(project: Project, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: project.id },
    include: {
      goldSource: { select: { id: true, position: true } },
      goldCopies: { select: { id: true, position: true, goldRetiredAt: true } },
      goldRevisions: {
        orderBy: { createdAt: 'desc' },
        include: { changedBy: { select: { name: true } } },
      },
    },
  });
  if (!task) return null;
  const schema = projectSchema(project);
  const isGold = task.isGold && task.goldAnswer !== null;
  const [rescorePlan, retireImpact] = isGold
    ? await Promise.all([previewRescore(project, taskId), previewRetire(project, taskId)])
    : [null, null];
  const users = new Set([
    ...(rescorePlan?.impact.moved ?? []).map((m) => m.userId),
    ...(retireImpact?.moved ?? []).map((m) => m.userId),
  ]);
  const people = await prisma.user.findMany({
    where: { id: { in: [...users] } },
    select: { id: true, name: true },
  });
  return {
    isGold,
    isQualification: task.isQualification && task.goldAnswer !== null,
    answer: (task.goldAnswer ?? null) as Answer | null,
    retiredAt: task.goldRetiredAt,
    source: task.goldSource,
    copies: task.goldCopies.map((c) => ({
      id: c.id,
      position: c.position,
      retired: c.goldRetiredAt !== null,
    })),
    revisions: task.goldRevisions.map((r) => ({
      id: r.id,
      change: r.change,
      by: r.changedBy.name,
      at: r.createdAt,
      reason: r.reason,
      from: r.previousAnswer ? describeGoldAnswer(schema, r.previousAnswer) : null,
      to: r.answer ? describeGoldAnswer(schema, r.answer) : null,
    })),
    rescore: rescorePlan,
    retireImpact,
    names: Object.fromEntries(people.map((p) => [p.id, p.name])),
  };
}

/**
 * The gold tasks annotators miss most often: the lowest average score first.
 * A gold task that most people get wrong is usually the one that is wrong.
 * Retired tasks and tasks with a single answer are left out.
 */
export async function lowestGoldTasks(project: Project, take = 5) {
  const groups = await prisma.assignment.groupBy({
    by: ['taskId'],
    where: counted(project.id),
    _avg: { goldScore: true },
    _count: { _all: true },
  });
  const lowest = groups
    .filter((g) => g._count._all >= 2)
    .sort((a, b) => (a._avg.goldScore ?? 0) - (b._avg.goldScore ?? 0))
    .slice(0, take);
  const tasks = await prisma.task.findMany({
    where: { id: { in: lowest.map((g) => g.taskId) } },
    select: { id: true, position: true, externalId: true, data: true },
  });
  const schema = projectSchema(project);
  return lowest.flatMap((g) => {
    const task = tasks.find((t) => t.id === g.taskId);
    if (!task) return [];
    return [
      {
        taskId: task.id,
        position: task.position,
        externalId: task.externalId,
        preview: taskPreview(schema, task.data, 70),
        answers: g._count._all,
        average: Math.round((g._avg.goldScore ?? 0) * 100) / 100,
      },
    ];
  });
}
