import { Prisma } from '@prisma/client';

import type { Answer } from '~/domain/answers';
import { scoreAgainstGold } from '~/domain/gold';
import { parsePrelabel, suggest } from '~/domain/prelabel';
import { parseTaskSchema } from '~/domain/task-schema';
import { prisma } from '~/lib/db.server';

/**
 * Running a project's suggestion rule over a batch. It never runs inside the
 * request that imported the batch: the import marks the batch `PENDING` and
 * `startPrelabel` runs it after the response has gone, in the same process.
 * A run stops after `PRELABEL_TIME_LIMIT_MS` and says so on the batch; what it
 * did is kept, and "Continue" on the batch page goes on from there. One task
 * costs a bounded amount of work (see `findTerms`), so the limit holds. A batch
 * that was left `PENDING` by a restart is picked up when its page is opened.
 *
 * Only tasks that have no suggestion yet and that nobody has been handed are
 * touched (a file's `_prediction` wins over the rule), and never
 * qualification questions. A rule that finds
 * nothing for a task still marks it, so it is not tried again.
 */

export const PRELABEL_TIME_LIMIT_MS = 15_000;
const CHUNK = 200;

export type PrelabelState = 'PENDING' | 'DONE' | 'TIMED_OUT' | 'FAILED';

export type PrelabelOutcome = { state: PrelabelState; suggested: number; tried: number };

/** Runs this process has going now, by batch. */
const running = new Map<string, Promise<void>>();

/** Starts a run in the background, unless one is going already. Returns at once. */
export function startPrelabel(batchId: string): void {
  if (running.has(batchId)) return;
  const run = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => runPrelabel(batchId))
    .then(
      () => undefined,
      async () => {
        await prisma.batch
          .update({
            where: { id: batchId },
            data: { prelabelState: 'FAILED', prelabelNote: 'The suggestion rule failed.' },
          })
          .catch(() => {});
      },
    )
    .finally(() => running.delete(batchId));
  running.set(batchId, run);
}

export function isPrelabelRunning(batchId: string): boolean {
  return running.has(batchId);
}

/** Waits until the runs going now have ended. For tests and for a clean shutdown. */
export async function prelabelsSettled(): Promise<void> {
  while (running.size > 0) await Promise.all(running.values());
}

/**
 * Runs the rule over the batch's tasks that have no suggestion yet. `clock`
 * is for tests. Returns what it did, and writes the same on the batch.
 */
export async function runPrelabel(
  batchId: string,
  options: { timeLimitMs?: number; clock?: () => number } = {},
): Promise<PrelabelOutcome> {
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.timeLimitMs ?? PRELABEL_TIME_LIMIT_MS);
  const batch = await prisma.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { project: { select: { schema: true, prelabel: true } } },
  });
  const finish = async (outcome: PrelabelOutcome, note: string) => {
    await prisma.batch.update({
      where: { id: batchId },
      data: { prelabelState: outcome.state, prelabelNote: note },
    });
    return outcome;
  };
  const schema = parseTaskSchema(batch.project.schema);
  const rule = schema.ok ? parsePrelabel(batch.project.prelabel, schema.schema) : null;
  if (!schema.ok || !rule?.ok || !rule.config) {
    return finish({ state: 'DONE', suggested: 0, tried: 0 }, 'The project has no suggestion rule.');
  }
  const config = rule.config;

  let suggested = 0;
  let tried = 0;
  let after = 0;
  for (;;) {
    // tasks nobody has been handed yet: someone who has the task open keeps
    // seeing what they saw
    const tasks = await prisma.task.findMany({
      where: {
        batchId,
        isQualification: false,
        suggestionSource: null,
        assignments: { none: {} },
        position: { gt: after },
      },
      orderBy: { position: 'asc' },
      take: CHUNK,
      select: { id: true, position: true, data: true },
    });
    if (tasks.length === 0) break;
    const made: Array<{ id: string; answer: unknown }> = [];
    let stopped = false;
    for (const task of tasks) {
      if (clock() >= deadline) {
        stopped = true;
        break;
      }
      made.push({
        id: task.id,
        answer: suggest(schema.schema, task.data as Record<string, unknown>, config),
      });
      after = task.position;
    }
    const written = await writeSuggestions(made, config.rule);
    tried += written.tried;
    suggested += written.suggested;
    if (stopped) {
      return finish(
        { state: 'TIMED_OUT', suggested, tried },
        `Stopped after ${tried} tasks, at the time limit. Continue to go on from there.`,
      );
    }
  }
  return finish(
    { state: 'DONE', suggested, tried },
    `Suggested an answer for ${suggested} of ${tried} tasks.`,
  );
}

/**
 * Writes what a run made, in the lock order of the rest of the app: the task
 * rows by id first, then a statement that checks, under those locks, that the
 * task still has no suggestion and nobody has been handed it. A claim that
 * got there first keeps the task as its annotator saw it.
 */
async function writeSuggestions(
  made: ReadonlyArray<{ id: string; answer: unknown }>,
  source: string,
): Promise<{ tried: number; suggested: number }> {
  if (made.length === 0) return { tried: 0, suggested: 0 };
  return prisma.$transaction(async (tx) => {
    const ids = made.map((m) => m.id);
    await tx.$queryRaw`SELECT id FROM "Task" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    let tried = 0;
    let suggested = 0;
    for (const { id, answer } of made) {
      const json = answer === null ? null : JSON.stringify(answer);
      const count = await tx.$executeRaw`
        UPDATE "Task" SET suggestion = ${json}::jsonb, "suggestionSource" = ${source}
        WHERE id = ${id} AND "suggestionSource" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "Assignment" a WHERE a."taskId" = "Task".id)`;
      if (count > 0) {
        tried += 1;
        if (answer !== null) suggested += 1;
      }
    }
    return { tried, suggested };
  });
}

/**
 * For "Run again from scratch" after the rule changed: takes back what the
 * rule suggested on tasks nobody has been handed, so the rule as it is now
 * suggests again. A file's predictions stay, and so does every suggestion
 * someone has seen. Same lock order as `writeSuggestions`.
 */
export async function resetRuleSuggestions(batchId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT id FROM "Task"
      WHERE "batchId" = ${batchId} AND "suggestionSource" IS NOT NULL AND "suggestionSource" <> 'file'
      ORDER BY id FOR UPDATE`;
    const reset = await tx.$executeRaw`
      UPDATE "Task" SET suggestion = NULL, "suggestionSource" = NULL
      WHERE "batchId" = ${batchId} AND "suggestionSource" IS NOT NULL AND "suggestionSource" <> 'file'
        AND NOT EXISTS (SELECT 1 FROM "Assignment" a WHERE a."taskId" = "Task".id)`;
    await tx.batch.update({
      where: { id: batchId },
      data: { prelabelState: 'PENDING', prelabelNote: null },
    });
    return reset;
  });
}

/** For "Continue" after a run stopped at its time limit: goes on with the tasks still to do. */
export async function continuePrelabel(batchId: string): Promise<void> {
  await prisma.batch.update({
    where: { id: batchId },
    data: { prelabelState: 'PENDING', prelabelNote: null },
  });
}

export type SuggestionQuality = {
  /** tasks of the project that carry a suggestion, gold included */
  tasks: number;
  annotators: Array<{
    userId: string;
    name: string;
    /** their submissions on tasks with a suggestion */
    withSuggestion: number;
    /** of those, handed in exactly as suggested */
    unchanged: number;
    /** average active seconds on those submissions */
    avgSeconds: number | null;
  }>;
  /** the suggestions on gold tasks scored against the gold answers, by where they came from */
  againstGold: Array<{ source: string; tasks: number; score: number }>;
  /**
   * Regular tasks have suggestions from the file and the project has no rule,
   * while there are gold tasks: those have none, so they can be told apart.
   */
  goldStandsOut: boolean;
};

/**
 * How suggestions are used and how good they are, for the quality page. The
 * suggestions themselves count nowhere else: not in consensus, agreement,
 * gold scores or pay.
 */
export async function suggestionQuality(project: {
  id: string;
  schema: Prisma.JsonValue;
  prelabel: Prisma.JsonValue;
}): Promise<SuggestionQuality> {
  const schema = parseTaskSchema(project.schema);
  const [tasks, submissions, gold] = await Promise.all([
    prisma.task.count({
      where: { projectId: project.id, NOT: { suggestion: { equals: Prisma.DbNull } } },
    }),
    prisma.assignment.findMany({
      where: { projectId: project.id, status: 'SUBMITTED', suggestionUnchanged: { not: null } },
      select: {
        userId: true,
        suggestionUnchanged: true,
        activeSeconds: true,
        user: { select: { name: true } },
      },
    }),
    prisma.task.findMany({
      where: {
        projectId: project.id,
        isGold: true,
        goldRetiredAt: null,
        NOT: { suggestion: { equals: Prisma.DbNull } },
      },
      select: { suggestion: true, suggestionSource: true, goldAnswer: true },
    }),
  ]);

  const people = new Map<string, SuggestionQuality['annotators'][number] & { seconds: number }>();
  for (const s of submissions) {
    const row = people.get(s.userId) ?? {
      userId: s.userId,
      name: s.user.name,
      withSuggestion: 0,
      unchanged: 0,
      avgSeconds: null,
      seconds: 0,
    };
    row.withSuggestion += 1;
    if (s.suggestionUnchanged) row.unchanged += 1;
    row.seconds += s.activeSeconds;
    people.set(s.userId, row);
  }

  const bySource = new Map<string, number[]>();
  if (schema.ok) {
    for (const t of gold) {
      if (t.goldAnswer === null || t.suggestion === null) continue;
      const source = t.suggestionSource ?? 'file';
      const score = scoreAgainstGold(schema.schema, t.suggestion as Answer, t.goldAnswer as Answer);
      bySource.set(source, [...(bySource.get(source) ?? []), score]);
    }
  }

  const [fromFile, goldTasks] = await Promise.all([
    prisma.task.count({
      where: { projectId: project.id, isGold: false, suggestionSource: 'file' },
    }),
    prisma.task.count({ where: { projectId: project.id, isGold: true, goldRetiredAt: null } }),
  ]);
  return {
    tasks,
    goldStandsOut: fromFile > 0 && goldTasks > 0 && project.prelabel === null,
    annotators: [...people.values()]
      .map(({ seconds, ...row }) => ({
        ...row,
        avgSeconds: row.withSuggestion ? Math.round(seconds / row.withSuggestion) : null,
      }))
      .sort((a, b) => b.withSuggestion - a.withSuggestion || a.name.localeCompare(b.name)),
    againstGold: [...bySource].map(([source, scores]) => ({
      source,
      tasks: scores.length,
      score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10_000) / 10_000,
    })),
  };
}
