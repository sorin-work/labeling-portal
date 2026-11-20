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
 * did is kept, and "Run again" on the batch page goes on from there. A batch
 * that was left `PENDING` by a restart is picked up when its page is opened.
 *
 * Only tasks that have no suggestion yet are touched (a file's `_prediction`
 * wins over the rule), and never qualification questions. A rule that finds
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
    const tasks = await prisma.task.findMany({
      where: {
        batchId,
        isQualification: false,
        suggestionSource: null,
        position: { gt: after },
      },
      orderBy: { position: 'asc' },
      take: CHUNK,
      select: { id: true, position: true, data: true },
    });
    if (tasks.length === 0) break;
    for (const task of tasks) {
      if (clock() >= deadline) {
        return finish(
          { state: 'TIMED_OUT', suggested, tried },
          `Stopped after ${tried} tasks, at the time limit. Run it again to go on.`,
        );
      }
      const answer = suggest(schema.schema, task.data as Record<string, unknown>, config);
      // only where nothing has been suggested in the meantime
      await prisma.task.updateMany({
        where: { id: task.id, suggestionSource: null },
        data: {
          suggestion: answer === null ? undefined : (answer as Prisma.InputJsonValue),
          suggestionSource: config.rule,
        },
      });
      tried += 1;
      if (answer !== null) suggested += 1;
      after = task.position;
    }
  }
  return finish(
    { state: 'DONE', suggested, tried },
    `Suggested an answer for ${suggested} of ${tried} tasks.`,
  );
}

/**
 * Takes back what the rule suggested on tasks nobody has started yet, so a
 * changed rule can run again. Suggestions from the file stay, and so does
 * every suggestion someone has already seen.
 */
export async function resetRuleSuggestions(batchId: string): Promise<number> {
  const reset = await prisma.task.updateMany({
    where: {
      batchId,
      suggestionSource: { not: null, notIn: ['file'] },
      assignments: { none: {} },
    },
    data: { suggestion: Prisma.DbNull, suggestionSource: null },
  });
  await prisma.batch.update({
    where: { id: batchId },
    data: { prelabelState: 'PENDING', prelabelNote: null },
  });
  return reset.count;
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
};

/**
 * How suggestions are used and how good they are, for the quality page. The
 * suggestions themselves count nowhere else: not in consensus, agreement,
 * gold scores or pay.
 */
export async function suggestionQuality(project: {
  id: string;
  schema: Prisma.JsonValue;
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

  return {
    tasks,
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
