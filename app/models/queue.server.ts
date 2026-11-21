import { Prisma, type Assignment, type PayMode, type Project } from '@prisma/client';

import {
  clampActiveSeconds,
  creditHorizon,
  creditTime,
  firstSubmissionCap,
  mergeIntervals,
  revisionCap,
  revisionSeconds,
  type Credit,
  type Interval,
} from '~/domain/active-time';
import { startOfUtcDay, underLimit } from '~/domain/daily-limit';
import { sameAnswer } from '~/domain/gold';
import { payableSince } from '~/domain/payouts';
import { goldDraw, SESSION_GAP_MINUTES } from '~/domain/queue-order';
import { holdCutoff } from '~/domain/review-hold';
import { decideReview, type SamplingDecision } from '~/domain/review-sampling';
import { takeBackRefusal, type TakeBackRefusal, type TakeBackState } from '~/domain/take-back';
import { extensionsLeft, inExtendWindow, MAX_EXTENSIONS } from '~/domain/time-limit';
import {
  isLockConflict,
  lockTaskOfAssignment,
  prisma,
  retryOnLockConflict,
  utc,
} from '~/lib/db.server';

import { logActivity } from './activity.server';
import { blockedByDispute } from './disputes.server';
import { scoreGoldSubmission } from './gold.server';
import { isAnnotatorFlagged } from './quality.server';
import { refreshTaskStatus } from './tasks.server';

export type ClaimResult =
  | { ok: true; assignment: Assignment; resumed: boolean }
  | { ok: false; reason: 'inactive' | 'empty' | 'unqualified' | 'limit' };

const MAX_CLAIM_ATTEMPTS = 5;

/** A claim that ends (submitted, skipped, released, expired) drops its draft. */
const NO_DRAFT = { draft: Prisma.DbNull, draftSeconds: 0 };

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** The annotator's claim that is still within its time limit, if any. */
export function findActiveAssignment(projectId: string, userId: string, now = new Date()) {
  return prisma.assignment.findFirst({
    where: { projectId, userId, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: { claimedAt: 'desc' },
  });
}

/**
 * SQL condition on task `t`: open, not part of the qualification test, not a
 * retired gold task, not in a paused batch, not already claimed, done or
 * skipped by this annotator, and (unless it is a gold task) with fewer live
 * claims and submissions than `overlap` plus the extra slots a task under the
 * agreement threshold was given. A completed task and the gold tasks
 * copied from it are one group: someone who has labeled, skipped or holds any
 * task of the group gets none of the others, because seeing the same item
 * twice would tell them it is gold.
 *
 * This is the whole rule for "may this annotator be given this task". The
 * pick, the check under the lock and the count on the dashboard all use it.
 *
 * The slots are counted by `Task.takenSlots`: the claims and submissions of
 * the task (`ACTIVE` or `SUBMITTED`), kept by a trigger on "Assignment" in
 * the statement that writes the assignment, so it cannot drift from the rows.
 * A claim past its time limit is counted until it is marked expired, so every
 * caller first runs `releaseExpiredClaims` with the same `now`; after that
 * the counter is exactly the old count of live claims and submissions, and a
 * full task is passed over on its own row, without a query per task.
 */
function eligibleFor(userId: string, overlap: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(
    t.status = 'OPEN'
    AND NOT t."isQualification"
    AND t."goldRetiredAt" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "Batch" held WHERE held.id = t."batchId" AND held."pausedAt" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Assignment" mine
      WHERE mine."taskId" = t.id AND mine."userId" = ${userId}
        AND mine.status IN ('ACTIVE', 'SUBMITTED', 'SKIPPED')
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Task" kin
      JOIN "Assignment" mine ON mine."taskId" = kin.id
      WHERE (kin.id = t."goldSourceId" OR kin."goldSourceId" = COALESCE(t."goldSourceId", t.id))
        AND mine."userId" = ${userId}
        AND mine.status IN ('ACTIVE', 'SUBMITTED', 'SKIPPED')
    )
    AND (t."isGold" OR t."takenSlots" < ${overlap} + t."extraSlots")
  )`;
}

export type PickOptions = {
  project: Project;
  userId: string;
  now: Date;
  /**
   * The project's queue secret (`queueSecretFor`). The shuffled order and the
   * gold draw are HMACs keyed with it, so nothing an annotator sees (ids,
   * times, which of their tasks were gold) tells them what comes next.
   */
  secret: string;
  /**
   * `skip` (the default) locks the picked task and passes over tasks that
   * other claims hold right now; `none` takes no lock at all and only says
   * which task would come next, for a claim that is about to wait for it.
   */
  lock?: 'skip' | 'none';
};

/**
 * The project's queue secret, made on first use for a project created after
 * the migration. It stays on the server: it is in a table of its own, which
 * no loader reads.
 */
export async function queueSecretFor(
  db: Prisma.TransactionClient,
  projectId: string,
): Promise<string> {
  const read = () =>
    db.$queryRaw<Array<{ secret: string }>>`
      SELECT secret FROM "QueueSecret" WHERE "projectId" = ${projectId}`;
  let rows = await read();
  if (rows.length === 0) {
    await db.$executeRaw`
      INSERT INTO "QueueSecret" ("projectId") VALUES (${projectId})
      ON CONFLICT ("projectId") DO NOTHING`;
    rows = await read();
  }
  return rows[0].secret;
}

/** A 32-bit number from an HMAC of `text` keyed with the secret, as SQL. */
function keyedHash(text: Prisma.Sql, secret: string): Prisma.Sql {
  return Prisma.sql`('x' || substr(encode(hmac((${text})::text, ${secret}::text, 'sha256'), 'hex'), 1, 8))::bit(32)::bigint`;
}

/**
 * "Is a gold task due for this annotator?", as CTEs. Each claim is a draw
 * with a chance of 1 in N (`goldDraw`): an HMAC of the annotator and their
 * latest submission or skip, keyed with the project's secret. So the answer
 * is the same on a reload, new after every task they hand in or skip, and
 * independent of what came before. It is never due for the first task of a
 * session, nor when the cap of recent gold tasks is reached.
 */
function goldDueCtes(options: Omit<PickOptions, 'wait'>, goldEvery: number): Prisma.Sql {
  const { project, userId, now, secret } = options;
  const { below, window, max } = goldDraw(goldEvery);
  const sessionStart = addMinutes(now, -SESSION_GAP_MINUTES);
  return Prisma.sql`
    WITH recent AS (
      SELECT a."submittedAt", g."isGold"
      FROM "Assignment" a
      JOIN "Task" g ON g.id = a."taskId"
      WHERE a."userId" = ${userId} AND a."projectId" = ${project.id}
        AND a.status = 'SUBMITTED' AND a."submittedAt" IS NOT NULL
      ORDER BY a."submittedAt" DESC, a.id DESC
      LIMIT ${window}
    ),
    latest AS (
      SELECT COALESCE((
        SELECT a.id FROM "Assignment" a
        WHERE a."userId" = ${userId} AND a."projectId" = ${project.id}
          AND a.status IN ('SUBMITTED', 'SKIPPED')
        ORDER BY a."claimedAt" DESC, a.id DESC
        LIMIT 1
      ), '') AS id
    ),
    spacing AS (
      SELECT (
        ${keyedHash(Prisma.sql`'gold:' || ${userId} || ':' || latest.id`, secret)} < ${below}
        AND (SELECT count(*) FROM recent r WHERE r."isGold") < ${max}
        AND NOT COALESCE((SELECT max(r."submittedAt") FROM recent r) <= ${utc(sessionStart)}, true)
      ) AS due
      FROM latest
    )`;
}

/**
 * The statement that decides which task an annotator gets next, and locks it.
 * Everything about the order is in here, in one statement:
 *
 * 1. With gold spacing on, the kind of task that is wanted now (gold when one
 *    is due, a regular task otherwise) comes first and the other kind second,
 *    so the queue never runs dry while something eligible is left.
 * 2. Batches that are not paused, the highest priority first, then in import
 *    order (by their first position).
 * 3. Inside a batch, by position or, in a shuffled project, by an HMAC of
 *    the annotator and the task keyed with the project's secret: an order of
 *    their own for everyone, always the same one for the same person, and
 *    not one they can work out.
 *
 * The three levels are nested lateral joins with `LIMIT 1`. PostgreSQL runs
 * them as nested loops and stops at the first row, so only the batches up to
 * the one that has an eligible task are looked at, and only the task that is
 * picked gets locked. The statement has no `ORDER BY` at the top on purpose:
 * that would sort the output and so visit, and lock, a task in every batch.
 *
 * `FOR UPDATE SKIP LOCKED` passes over tasks another annotator is claiming at
 * this very moment. The caller still checks the task again before it claims
 * it: whether a slot is free is a count over other people's claims, and this
 * statement may have counted before one of them was committed.
 */
export function nextTaskSql(options: PickOptions): Prisma.Sql {
  const { project, userId, now, secret, lock: mode = 'skip' } = options;
  const lock = mode === 'none' ? Prisma.empty : Prisma.sql`FOR UPDATE OF t SKIP LOCKED`;
  const eligible = eligibleFor(userId, Prisma.sql`${project.overlap}`);
  const spaced = project.goldEvery !== null;

  // the first eligible task of batch `b` (of kind `c` when gold is spaced)
  const inBatch =
    project.queueOrder === 'SHUFFLED'
      ? Prisma.sql`
          SELECT t.id
          FROM (
            SELECT s.id, hmac('order:' || ${userId} || ':' || s.id, ${secret}::text, 'sha256') AS shuffled
            FROM "Task" s
            WHERE s."batchId" = b.id AND s.status = 'OPEN'
              ${spaced ? Prisma.sql`AND s."isGold" = c.gold` : Prisma.empty}
              -- the cheap part of eligibleFor, so full tasks are not hashed and sorted
              AND NOT s."isQualification" AND s."goldRetiredAt" IS NULL
              AND (s."isGold" OR s."takenSlots" < ${project.overlap} + s."extraSlots")
            ORDER BY shuffled
          ) s
          JOIN "Task" t ON t.id = s.id
          WHERE ${eligible}
          ORDER BY s.shuffled
          LIMIT 1
          ${lock}`
      : Prisma.sql`
          SELECT t.id
          FROM "Task" t
          WHERE t."batchId" = b.id
            ${spaced ? Prisma.sql`AND t."isGold" = c.gold` : Prisma.empty}
            AND ${eligible}
          ORDER BY t.position, t.id
          LIMIT 1
          ${lock}`;

  const inProject = Prisma.sql`
    SELECT task.id
    FROM (
      SELECT b.id
      FROM "Batch" b
      WHERE b."projectId" = ${project.id} AND b."pausedAt" IS NULL
      ORDER BY
        b.priority DESC,
        (SELECT min(f.position) FROM "Task" f WHERE f."batchId" = b.id) NULLS LAST,
        b.id
    ) b
    CROSS JOIN LATERAL (${inBatch}) task
    LIMIT 1`;

  if (!spaced) return inProject;
  return Prisma.sql`
    ${goldDueCtes({ project, userId, now, secret }, project.goldEvery ?? 0)}
    SELECT pick.id, c.wanted
    FROM (
      SELECT want.gold, (want.gold = spacing.due) AS wanted
      FROM spacing, (VALUES (true), (false)) AS want(gold)
      ORDER BY (want.gold = spacing.due) DESC
    ) c
    CROSS JOIN LATERAL (${inProject}) pick
    LIMIT 1`;
}

/**
 * Picks the task the annotator gets next and locks its row for the rest of
 * the transaction, or returns null when there is none. The same inputs and
 * the same secret give the same task.
 */
export async function pickNextTask(
  tx: Prisma.TransactionClient,
  options: PickOptions,
): Promise<string | null> {
  return (await pickWithKind(tx, options))?.id ?? null;
}

/**
 * The pick, and whether the task is of the kind gold spacing wanted for this
 * claim (always true without spacing). Not the wanted kind means either that
 * none of that kind is left for this annotator, or that every one of them is
 * being claimed by someone else at this moment and was passed over.
 */
async function pickWithKind(
  tx: Prisma.TransactionClient,
  options: PickOptions,
): Promise<{ id: string; wanted: boolean } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; wanted?: boolean }>>(nextTaskSql(options));
  const row = rows[0];
  return row ? { id: row.id, wanted: row.wanted ?? true } : null;
}

/**
 * Marks the claims of the given projects (all projects when null) that ran
 * past their time limit as expired. The tasks of those claims are locked
 * first, in id order, and only then are the claims written: the task row
 * before the assignment row, as everywhere, and the same order in every
 * statement, so two of these and a submission never wait for each other in a
 * circle.
 */
async function expireClaims(projectIds: string[] | null, now: Date): Promise<number> {
  return retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      const inProjects = projectIds
        ? Prisma.sql`AND a."projectId" IN (${Prisma.join(projectIds)})`
        : Prisma.empty;
      const tasks = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Task" t
        WHERE t.id IN (
          SELECT a."taskId" FROM "Assignment" a
          WHERE a.status = 'ACTIVE' AND a."expiresAt" <= ${utc(now)} ${inProjects}
        )
        ORDER BY t.id
        FOR NO KEY UPDATE`;
      if (tasks.length === 0) return 0;
      const result = await tx.assignment.updateMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lte: now },
          taskId: { in: tasks.map((t) => t.id) },
          ...(projectIds ? { projectId: { in: projectIds } } : {}),
        },
        data: { status: 'EXPIRED', ...NO_DRAFT },
      });
      return result.count;
    }),
  );
}

/**
 * Marks claims that ran past their time limit as expired so the task goes back
 * to the queue. Runs lazily whenever someone asks for work.
 */
export async function releaseExpiredClaims(projectId?: string, now = new Date()): Promise<number> {
  return expireClaims(projectId ? [projectId] : null, now);
}

/** How many tasks the annotator could still pick up in each project. */
export async function countAvailable(
  projectIds: string[],
  userId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  // the slot counter counts a claim past its limit until it is marked expired
  await expireClaims(projectIds, now);
  const [rows, atLimit] = await Promise.all([
    prisma.$queryRaw<Array<{ projectId: string; count: bigint }>>`
      SELECT t."projectId", count(*) AS count
      FROM "Task" t
      JOIN "Project" p ON p.id = t."projectId"
      WHERE t."projectId" IN (${Prisma.join(projectIds)})
        AND ${eligibleFor(userId, Prisma.sql`p.overlap`)}
      GROUP BY t."projectId"`,
    projectsAtLimit(projectIds, userId, now),
  ]);
  // a claim refuses someone at the daily limit, so the dashboard offers nothing there
  return new Map(rows.map((r) => [r.projectId, atLimit.has(r.projectId) ? 0 : Number(r.count)]));
}

/**
 * What counts towards a project's daily limit for one person: their
 * submissions since midnight UTC (the "done today" of the work page) and the
 * claims they hold. Skips do not count.
 */
export async function dailyCount(
  db: Prisma.TransactionClient,
  projectId: string,
  userId: string,
  now: Date,
): Promise<{ submittedToday: number; open: number }> {
  const [submittedToday, open] = await Promise.all([
    db.assignment.count({
      where: { projectId, userId, status: 'SUBMITTED', submittedAt: { gte: startOfUtcDay(now) } },
    }),
    db.assignment.count({
      where: { projectId, userId, status: 'ACTIVE', expiresAt: { gt: now } },
    }),
  ]);
  return { submittedToday, open };
}

/** The projects among these with a daily limit that the person has reached. */
async function projectsAtLimit(
  projectIds: string[],
  userId: string,
  now: Date,
): Promise<Set<string>> {
  const limited = await prisma.project.findMany({
    where: { id: { in: projectIds }, dailyTaskLimit: { not: null } },
    select: { id: true, dailyTaskLimit: true },
  });
  const reached = await Promise.all(
    limited.map(async (project) => {
      const { submittedToday, open } = await dailyCount(prisma, project.id, userId, now);
      return underLimit(project.dailyTaskLimit, submittedToday, open) ? null : project.id;
    }),
  );
  return new Set(reached.filter((id) => id !== null));
}

/**
 * Waits until no other transaction holds the task's row, for at most two
 * seconds, and lets go of it at once. The transaction holds no other lock
 * while it waits, and waits on exactly one row, so two waiting claims, or a
 * claim and an expiry or a gold copy, cannot wait for each other in a circle.
 * A wait that times out is not an error: the claim picks again.
 */
async function waitForTask(taskId: string): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
      await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${taskId} FOR UPDATE`;
    });
  } catch (error) {
    if (!isLockConflict(error)) throw error;
  }
}

/**
 * Gives the annotator their current claim, or claims the next available task.
 * Which task that is, is `nextTaskSql`.
 */
export async function claimNextTask(
  project: Project,
  userId: string,
  now = new Date(),
): Promise<ClaimResult> {
  await releaseExpiredClaims(project.id, now);
  const existing = await findActiveAssignment(project.id, userId, now);
  if (existing) return { ok: true, assignment: existing, resumed: true };
  if (project.status !== 'ACTIVE') return { ok: false, reason: 'inactive' };
  if (project.qualificationRequired) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
    });
    if (!member?.qualifiedAt) return { ok: false, reason: 'unqualified' };
  }

  const pick = { project, userId, now, secret: await queueSecretFor(prisma, project.id) };
  // set once this claim has waited for a task of the kind gold spacing wants
  let waitedForWanted = false;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const outcome = await retryOnLockConflict(() =>
      prisma.$transaction(async (tx) => {
        // The pick locks the task and passes over tasks that other claims
        // hold right now. When that leaves nothing, or only the other kind
        // than gold spacing wants (a fresh annotator would get gold first and
        // a regular slot would go unused), the task that would come next is
        // looked up without a lock and this transaction ends, letting go of
        // what it picked. The claim then waits for that one task in a
        // transaction of its own (`waitForTask`) and picks again.
        if (project.dailyTaskLimit !== null) {
          // The daily limit is counted under a lock on the person's work
          // clock, which comes before every task row in the lock order, so
          // two tabs claiming at once are counted one after the other.
          await lockWorkClock(tx, project.orgId, userId, now);
          // the other tab may have claimed while this one waited for the lock
          const held = await tx.assignment.findFirst({
            where: { projectId: project.id, userId, status: 'ACTIVE', expiresAt: { gt: now } },
            orderBy: { claimedAt: 'desc' },
          });
          if (held) return { resumed: held };
          const { submittedToday, open } = await dailyCount(tx, project.id, userId, now);
          if (!underLimit(project.dailyTaskLimit, submittedToday, open)) return 'limit' as const;
        }
        const first = await pickWithKind(tx, pick);
        if (!first || (!first.wanted && !waitedForWanted)) {
          const next = await pickNextTask(tx, { ...pick, lock: 'none' });
          if (!next) return 'empty' as const;
          if (!first || next !== first.id) return { waitFor: next, forWanted: !!first };
        }
        const taskId = first.id;
        // With the row locked, look again in a statement of its own. The pick
        // counted the task's claims in its snapshot, and a claim that was
        // committed between that count and our lock is only visible now.
        const [check] = await tx.$queryRaw<Array<{ eligible: boolean }>>`
        SELECT ${eligibleFor(userId, Prisma.sql`${project.overlap}`)} AS eligible
        FROM "Task" t WHERE t.id = ${taskId}`;
        if (!check?.eligible) return null;
        return tx.assignment.create({
          data: {
            projectId: project.id,
            taskId,
            userId,
            claimedAt: now,
            expiresAt: addMinutes(now, project.timeLimitMinutes),
          },
        });
      }),
    );
    if (outcome === 'empty') return { ok: false, reason: 'empty' };
    if (outcome === 'limit') return { ok: false, reason: 'limit' };
    if (outcome && 'resumed' in outcome && outcome.resumed) {
      return { ok: true, assignment: outcome.resumed, resumed: true };
    }
    if (outcome && 'waitFor' in outcome) {
      if (outcome.forWanted) waitedForWanted = true;
      // a wait that runs out counts as this attempt
      await waitForTask(outcome.waitFor);
      continue;
    }
    if (outcome) return { ok: true, assignment: outcome, resumed: false };
  }
  return { ok: false, reason: 'empty' };
}

export type AssignmentError = 'not_found' | 'not_active' | 'expired';

async function ownActive(assignmentId: string, userId: string) {
  const assignment = await prisma.assignment.findFirst({ where: { id: assignmentId, userId } });
  if (!assignment) return { error: 'not_found' as const };
  if (assignment.status !== 'ACTIVE') return { error: 'not_active' as const };
  return { assignment };
}

export { clampActiveSeconds };

/**
 * A person's working clock in an organisation: the stretches of their time
 * already credited, read after a lock on their membership that lasts until
 * the transaction ends. Every credit goes through here, so two submissions of
 * one person are credited one after the other and the second sees what the
 * first took. The stretches are kept by organisation and user, so removing
 * and adding someone again keeps them. Null when the person has no
 * membership: then nothing is credited.
 */
async function lockWorkClock(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  now: Date,
): Promise<WorkClock> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Membership"
    WHERE "orgId" = ${orgId} AND "userId" = ${userId} FOR NO KEY UPDATE`;
  if (rows.length === 0) return null;
  const credited = await tx.creditedInterval.findMany({
    where: { orgId, userId, end: { gt: creditHorizon(now) } },
    select: { start: true, end: true },
  });
  return { orgId, userId, credited };
}

type WorkClock = { orgId: string; userId: string; credited: Interval[] } | null;

/**
 * Stores what a credit took. The person's stretches are written back merged,
 * and those that end before the horizon, which no credit can reach any more,
 * are removed, so the table holds a few rows per person.
 */
async function recordCredit(
  tx: Prisma.TransactionClient,
  clock: WorkClock,
  credit: Credit,
  now: Date,
) {
  if (!clock || credit.pieces.length === 0) return;
  const { orgId, userId } = clock;
  const merged = mergeIntervals([...clock.credited, ...credit.pieces]);
  await tx.creditedInterval.deleteMany({ where: { orgId, userId } });
  await tx.creditedInterval.createMany({
    data: merged
      .filter((interval) => interval.end > creditHorizon(now))
      .map((interval) => ({ orgId, userId, ...interval })),
  });
}

/**
 * Whether a new submission in a project that reviews work goes to a reviewer.
 * The annotator's history is only read when the project reviews a share.
 */
async function sampleForReview(
  projectId: string,
  userId: string,
  samplePercent: number,
  random: () => number,
): Promise<SamplingDecision> {
  if (samplePercent >= 100) {
    return decideReview({ samplePercent, sentToReviewBefore: 0, flagged: false }, random);
  }
  const [sentToReviewBefore, flagged] = await Promise.all([
    prisma.assignment.count({
      where: { projectId, userId, status: 'SUBMITTED', reviewStatus: { not: 'NOT_REQUIRED' } },
    }),
    isAnnotatorFlagged(projectId, userId),
  ]);
  return decideReview({ samplePercent, sentToReviewBefore, flagged }, random);
}

/**
 * How a submission relates to the task's suggestion. `suggestionUnchanged` is
 * set only where there was a suggestion; an answer that equals it counts as
 * started from it even when the page did not say so (a draft restored after
 * a reload).
 */
/**
 * Records that the annotator pressed "Start from the suggestion" on their
 * claim, at the moment they did. A submission reads it from here; the form
 * that hands the answer in has no say. Only on an active claim of theirs
 * whose task has a suggestion.
 */
export async function markSuggestionTaken(assignmentId: string, userId: string): Promise<boolean> {
  const marked = await prisma.assignment.updateMany({
    where: {
      id: assignmentId,
      userId,
      status: 'ACTIVE',
      task: { NOT: { suggestion: { equals: Prisma.DbNull } } },
    },
    data: { fromSuggestion: true },
  });
  return marked.count > 0;
}

function suggestionUse(
  suggestion: Prisma.JsonValue,
  answer: Prisma.InputJsonValue,
  started: boolean | undefined,
): { fromSuggestion: boolean; suggestionUnchanged: boolean | null } {
  if (suggestion === null) return { fromSuggestion: false, suggestionUnchanged: null };
  const unchanged = sameAnswer(answer, suggestion);
  return { fromSuggestion: Boolean(started) || unchanged, suggestionUnchanged: unchanged };
}

/**
 * Stores the answer on the annotator's claim. `random` is the source for the
 * review sample (see `decideReview`); tests pass a fixed one.
 */
export async function submitAssignment(
  assignmentId: string,
  userId: string,
  input: {
    answer: Prisma.InputJsonValue;
    activeSeconds: number;
    reviewRequired: boolean;
    /** share of submissions that go to review; everything when left out */
    reviewSamplePercent?: number;
  },
  now = new Date(),
  random: () => number = Math.random,
): Promise<{ ok: true; assignment: Assignment } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (found.assignment.expiresAt <= now) {
    // Too late: the answer is refused and the claim is marked as expired, but
    // only while it is still active. When the same form is posted twice
    // around the deadline, the first post may have been in time and stored,
    // and that submission must not be turned into an expired claim.
    const expired = await retryOnLockConflict(() =>
      prisma.$transaction(async (tx) => {
        await lockTaskOfAssignment(tx, assignmentId);
        return tx.assignment.updateMany({
          where: { id: assignmentId, status: 'ACTIVE' },
          data: { status: 'EXPIRED', ...NO_DRAFT },
        });
      }),
    );
    return { ok: false, error: expired.count > 0 ? 'expired' : 'not_active' };
  }

  // gold tasks are scored against their known answer instead of being reviewed
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: found.assignment.taskId },
    include: { project: { select: { schema: true, orgId: true, timeLimitMinutes: true } } },
  });

  // The sample is drawn here, once, and the outcome is stored. Nothing that
  // reads the submission later draws again.
  const sampling: SamplingDecision =
    input.reviewRequired && !task.isGold
      ? await sampleForReview(
          found.assignment.projectId,
          userId,
          input.reviewSamplePercent ?? 100,
          random,
        )
      : { review: false, sample: null };

  const reviewStatus = sampling.review ? 'PENDING' : 'NOT_REQUIRED';
  const assignment = await retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      // The person's clock first, in every transaction that credits time: the
      // claim is credited only the minutes of its window that no other work of
      // theirs has been credited, so the same minutes are not paid twice.
      const clock = await lockWorkClock(tx, task.project.orgId, userId, now);
      // then the task row, before the assignment row (lockTaskOfAssignment)
      await lockTaskOfAssignment(tx, assignmentId);
      const credit = creditTime({
        reported: clock ? input.activeSeconds : 0,
        start: found.assignment.claimedAt,
        now,
        credited: clock?.credited ?? [],
        // the claim plus at most one more limit, however often it was extended
        cap: firstSubmissionCap(task.project.timeLimitMinutes),
      });
      // scored here, under a lock on the expected answer, so a manager's edit of
      // it cannot fall between reading it and storing the score
      const goldScore = task.isGold
        ? await scoreGoldSubmission(tx, task.id, task.project.schema, input.answer)
        : null;
      // The rate is frozen in the write that submits the work, and it is read
      // here, in the same transaction, holding the project row: a settings save
      // that changes the rate either waits for this submission or is seen by it.
      const [pay] = await tx.$queryRaw<Array<{ rateCents: number; payMode: PayMode }>>`
      SELECT "rateCents", "payMode" FROM "Project"
      WHERE id = ${found.assignment.projectId} FOR SHARE`;
      // only a claim that is still active is written, so a form posted twice
      // cannot replace the first outcome with a second draw
      const [submitted] = await tx.assignment.updateManyAndReturn({
        where: { id: assignmentId, status: 'ACTIVE' },
        data: {
          status: 'SUBMITTED',
          submittedAt: now,
          rateCents: pay.rateCents,
          payMode: pay.payMode,
          // work that needs no review is payable from this moment
          payableAt: payableSince(reviewStatus, now),
          answer: input.answer,
          // what the task's suggestion had to do with it: it is never the answer
          // by itself, the annotator took it or wrote their own
          // whether they took it is what the server recorded (`markSuggestionTaken`),
          // not what the form says
          ...suggestionUse(task.suggestion, input.answer, found.assignment.fromSuggestion),
          goldScore,
          reviewStatus,
          reviewSample: sampling.sample,
          activeSeconds: credit.seconds,
          ...NO_DRAFT,
        },
      });
      if (submitted) await recordCredit(tx, clock, credit, now);
      // work that no reviewer will see is accepted at once and can complete the
      // task, in the same transaction as the write that accepts it
      if (submitted && !sampling.review && !task.isGold) {
        await refreshTaskStatus(submitted.taskId, tx, now);
      }
      return submitted;
    }),
  );
  if (!assignment) return { ok: false, error: 'not_active' };
  return { ok: true, assignment };
}

export async function skipAssignment(
  assignmentId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  // conditional for the same reason as in submitAssignment: a second post must
  // not turn a submission that was just stored into a skip
  const skipped = await retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      await lockTaskOfAssignment(tx, assignmentId);
      return tx.assignment.updateMany({
        where: { id: assignmentId, status: 'ACTIVE' },
        data: { status: 'SKIPPED', skipReason: reason, ...NO_DRAFT },
      });
    }),
  );
  return skipped.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
}

/** What crediting a revision needs to know about the submission. */
const REVISION_FIELDS = {
  reviewedAt: true,
  submittedAt: true,
  activeSeconds: true,
  draftSeconds: true,
  takenBackFrom: true,
  taskId: true,
  task: { select: { isGold: true } },
  project: { select: { timeLimitMinutes: true, orgId: true, schema: true } },
} satisfies Prisma.AssignmentSelect;

type Revised = Prisma.AssignmentGetPayload<{ select: typeof REVISION_FIELDS }>;

/** Revising starts when the reviewer sends the work back. */
function revisingSince(assignment: Revised, now: Date): Date {
  return assignment.reviewedAt ?? assignment.submittedAt ?? now;
}

/** The project's time limit as seconds, which is what a revision is held to. */
function limitSeconds(assignment: Revised): number {
  return assignment.project.timeLimitMinutes * 60;
}

/**
 * Replaces the answer on a submission a reviewer sent back and puts it in the
 * review queue again. Only the annotator who made it can do this, and not
 * while they dispute the decision: it is revise or dispute, never both. The
 * time spent revising is added to the active time through `creditTime`, held
 * to `revisionCap`. The rate stays the one frozen at the first submission.
 */
export async function resubmitAssignment(
  assignmentId: string,
  userId: string,
  input: { answer: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: AssignmentError | 'disputed' }> {
  // which organisation's clock to take, read without a lock: the project of
  // an assignment never changes
  const owner = await prisma.assignment.findFirst({
    where: { id: assignmentId, userId },
    select: { project: { select: { orgId: true } } },
  });
  return retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      // the full order (docs/architecture.md): the person's clock, then the
      // task row, then the assignment row
      const clock = owner ? await lockWorkClock(tx, owner.project.orgId, userId, now) : null;
      await lockTaskOfAssignment(tx, assignmentId);
      if (await blockedByDispute(tx, assignmentId)) return { ok: false, error: 'disputed' };
      const sentBack: Prisma.AssignmentWhereInput = {
        id: assignmentId,
        userId,
        status: 'SUBMITTED',
        reviewStatus: 'SENT_BACK',
      };
      const current = await tx.assignment.findFirst({ where: sentBack, select: REVISION_FIELDS });
      // the page counts on from the time saved with the draft, so the form has
      // at least that much; the larger one counts if it does not
      const reported = Number.isFinite(input.activeSeconds) ? input.activeSeconds : 0;
      const credit =
        current && clock
          ? creditTime({
              reported: Math.max(reported, current.draftSeconds),
              start: revisingSince(current, now),
              now,
              credited: clock.credited,
              cap: revisionCap(limitSeconds(current), current.activeSeconds),
            })
          : { seconds: 0, pieces: [] };
      // Work the annotator took back returns to the review status it had:
      // the review draw made at its first submission is kept, so taking back
      // is not a way to draw again. Work that needed no review is accepted
      // again at once, a gold task scored again.
      const accepted = current?.takenBackFrom === 'NOT_REQUIRED';
      const gold =
        accepted && current?.task.isGold
          ? {
              goldScore: await scoreGoldSubmission(
                tx,
                current.taskId,
                current.project.schema,
                input.answer,
              ),
            }
          : {};
      const result = await tx.assignment.updateMany({
        // still sent back: a form posted twice adds its time only once
        where: sentBack,
        data: {
          answer: input.answer,
          reviewStatus: accepted ? 'NOT_REQUIRED' : 'PENDING',
          submittedAt: now,
          reviewedAt: null,
          payableAt: accepted ? now : null,
          takenBackFrom: null,
          ...gold,
          activeSeconds: { increment: credit.seconds },
          ...NO_DRAFT,
        },
      });
      if (result.count > 0) await recordCredit(tx, clock, credit, now);
      if (result.count > 0 && accepted && current && !current.task.isGold) {
        await refreshTaskStatus(current.taskId, tx, now);
      }
      if (result.count === 0) {
        const exists = await tx.assignment.count({ where: { id: assignmentId, userId } });
        return { ok: false, error: exists ? 'not_active' : 'not_found' };
      }
      return { ok: true };
    }),
  );
}

/** Hands a claim back without an answer so someone else can take it. */
export async function releaseAssignment(
  assignmentId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const released = await retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      await lockTaskOfAssignment(tx, assignmentId);
      return tx.assignment.updateMany({
        where: { id: assignmentId, status: 'ACTIVE' },
        data: { status: 'RELEASED', ...NO_DRAFT },
      });
    }),
  );
  return released.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
}

export type ReleaseClaimResult =
  | { ok: true; creditedSeconds: number }
  | { ok: false; error: 'not_found' | 'not_active' | 'expired' };

/**
 * A manager takes a claim away from the annotator who holds it, so the task
 * goes back to the queue: what `releaseAssignment` does, without the owner
 * check. The draft is dropped. The annotator did nothing wrong, so on an
 * hourly project the working time their draft saves recorded
 * (`draftSeconds`) is credited the way a submission credits it, through
 * their work clock and `creditTime`, and becomes payable at once. A per-task
 * project pays for accepted tasks only, so nothing is credited there.
 *
 * A claim past its time limit has run out, whether or not anyone marked it
 * yet: it is marked expired here and nothing is credited, exactly as when
 * the expiry ran first, so the order of the two never changes the pay.
 *
 * The lock order is a submission's: the annotator's work clock, the task
 * row, then the assignment row. The audit entry is written in the same
 * transaction.
 */
export async function releaseClaim(
  project: Pick<Project, 'id' | 'orgId' | 'timeLimitMinutes'>,
  assignmentId: string,
  actorId: string,
  now = new Date(),
): Promise<ReleaseClaimResult> {
  // whose clock to take, read without a lock: the owner of a claim never changes
  const owner = await prisma.assignment.findFirst({
    where: { id: assignmentId, projectId: project.id },
    select: { userId: true, taskId: true, user: { select: { name: true } } },
  });
  if (!owner) return { ok: false, error: 'not_found' };
  return retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      const clock = await lockWorkClock(tx, project.orgId, owner.userId, now);
      await lockTaskOfAssignment(tx, assignmentId);
      const claim = await tx.assignment.findFirst({
        where: { id: assignmentId, status: 'ACTIVE' },
        select: { claimedAt: true, expiresAt: true, draftSeconds: true },
      });
      if (!claim) return { ok: false, error: 'not_active' } as const;
      if (claim.expiresAt <= now) {
        await tx.assignment.updateMany({
          where: { id: assignmentId, status: 'ACTIVE' },
          data: { status: 'EXPIRED', ...NO_DRAFT },
        });
        return { ok: false, error: 'expired' } as const;
      }
      // the pay mode as it is now, held against a settings save, as a submission reads it
      const [pay] = await tx.$queryRaw<Array<{ rateCents: number; payMode: PayMode }>>`
        SELECT "rateCents", "payMode" FROM "Project" WHERE id = ${project.id} FOR SHARE`;
      const credit =
        pay.payMode === 'HOURLY' && clock
          ? creditTime({
              reported: claim.draftSeconds,
              start: claim.claimedAt,
              now,
              credited: clock.credited,
              cap: firstSubmissionCap(project.timeLimitMinutes),
            })
          : { seconds: 0, pieces: [] };
      const paid =
        credit.seconds > 0
          ? { rateCents: pay.rateCents, payMode: pay.payMode, payableAt: now }
          : {};
      const released = await tx.assignment.updateMany({
        where: { id: assignmentId, status: 'ACTIVE' },
        data: { status: 'RELEASED', ...NO_DRAFT, activeSeconds: credit.seconds, ...paid },
      });
      if (released.count === 0) return { ok: false, error: 'not_active' } as const;
      await recordCredit(tx, clock, credit, now);
      const task = await tx.task.findUniqueOrThrow({
        where: { id: owner.taskId },
        select: { position: true },
      });
      await logActivity(tx, {
        orgId: project.orgId,
        projectId: project.id,
        actorId,
        action: 'assignment.released',
        detail: {
          taskId: owner.taskId,
          position: task.position,
          userId: owner.userId,
          userName: owner.user.name,
          seconds: credit.seconds,
        },
        createdAt: now,
      });
      return { ok: true, creditedSeconds: credit.seconds } as const;
    }),
  );
}

/**
 * Keeps unfinished work on a claim so that a reload does not lose it. The
 * draft is stored as it is; only submitting validates. `draft` is left out
 * when the answer did not change and the save only carries working time. That
 * time never goes down, so an older tab cannot take seconds away again.
 */
export async function saveDraft(
  assignmentId: string,
  userId: string,
  input: { draft?: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<{ ok: true; draftSeconds: number } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  if (found.assignment.expiresAt <= now) return { ok: false, error: 'expired' };
  const seconds = clampActiveSeconds(input.activeSeconds, found.assignment.claimedAt, now);
  const draft =
    input.draft === undefined
      ? Prisma.empty
      : Prisma.sql`, "draft" = ${JSON.stringify(input.draft)}::jsonb`;
  // One statement: the claim can be submitted or released since the check
  // above, and two tabs can save at the same moment without one of them
  // lowering the time again.
  const saved = await prisma.$queryRaw<Array<{ draftSeconds: number }>>`
    UPDATE "Assignment"
    SET "draftSeconds" = GREATEST("draftSeconds", ${seconds}::int)${draft}
    WHERE id = ${assignmentId} AND "userId" = ${userId} AND status = 'ACTIVE'
    RETURNING "draftSeconds"`;
  if (saved.length === 0) return { ok: false, error: 'not_active' };
  return { ok: true, draftSeconds: saved[0].draftSeconds };
}

/**
 * The same for the revise page. That assignment is submitted, not active, so
 * the guard is the one `resubmitAssignment` uses: the annotator's own
 * submission, while it is sent back and not under dispute. Work that is
 * disputed cannot be revised, so no revision of it is saved either. The time
 * spent revising is kept with the draft, within the same bounds as a
 * resubmission credits it, and never goes down.
 */
export async function saveRevisionDraft(
  assignmentId: string,
  userId: string,
  input: { draft?: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<
  { ok: true; draftSeconds: number } | { ok: false; error: AssignmentError | 'disputed' }
> {
  return prisma.$transaction(async (tx) => {
    if (await blockedByDispute(tx, assignmentId)) return { ok: false, error: 'disputed' };
    const current = await tx.assignment.findFirst({
      where: { id: assignmentId, userId },
      select: REVISION_FIELDS,
    });
    if (!current) return { ok: false, error: 'not_found' };
    // what the draft keeps is a count, not a credit: the resubmission credits it
    const seconds = revisionSeconds({
      reported: input.activeSeconds,
      reviewedAt: revisingSince(current, now),
      now,
      limitSeconds: limitSeconds(current),
      credited: current.activeSeconds,
    });
    const draft =
      input.draft === undefined
        ? Prisma.empty
        : Prisma.sql`, "draft" = ${JSON.stringify(input.draft)}::jsonb`;
    // one statement, for the same reasons as in saveDraft
    const saved = await tx.$queryRaw<Array<{ draftSeconds: number }>>`
      UPDATE "Assignment"
      SET "draftSeconds" = GREATEST("draftSeconds", ${seconds}::int)${draft}
      WHERE id = ${assignmentId} AND "userId" = ${userId}
        AND status = 'SUBMITTED' AND "reviewStatus" = 'SENT_BACK'
      RETURNING "draftSeconds"`;
    if (saved.length === 0) return { ok: false, error: 'not_active' };
    return { ok: true, draftSeconds: saved[0].draftSeconds };
  });
}

/**
 * Gives the annotator another full time limit on their claim. Allowed
 * `MAX_EXTENSIONS` times, each in the last two minutes of the claim
 * (`EXTEND_WINDOW_MS`). The update
 * only goes through on the claim as it was read, so two requests at once
 * cannot both count as the same extension.
 */
export async function extendAssignment(
  assignmentId: string,
  userId: string,
  minutes: number,
  now = new Date(),
): Promise<
  | { ok: true; expiresAt: Date; extensionsLeft: number }
  | { ok: false; error: AssignmentError | 'no_extensions_left' | 'too_early' }
> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const { assignment } = found;
  if (assignment.expiresAt <= now) return { ok: false, error: 'expired' };
  if (assignment.extensions >= MAX_EXTENSIONS) return { ok: false, error: 'no_extensions_left' };
  // only in the last two minutes, when the warning shows: never all at once
  if (!inExtendWindow(assignment.expiresAt, now)) return { ok: false, error: 'too_early' };
  const expiresAt = addMinutes(assignment.expiresAt, minutes);
  const updated = await prisma.assignment.updateMany({
    where: {
      id: assignmentId,
      status: 'ACTIVE',
      expiresAt: assignment.expiresAt,
      extensions: assignment.extensions,
    },
    data: { expiresAt, extendedAt: now, extensions: { increment: 1 } },
  });
  if (updated.count === 0) return { ok: false, error: 'not_active' };
  return { ok: true, expiresAt, extensionsLeft: extensionsLeft(assignment.extensions + 1) };
}

/**
 * What the take-back rule (`takeBackRefusal`) needs to know about a
 * submission, read with `db`. Null when it is not the person's.
 */
export async function takeBackState(
  db: Prisma.TransactionClient,
  assignmentId: string,
  userId: string,
  now: Date,
): Promise<TakeBackState | null> {
  const row = await db.assignment.findFirst({
    where: { id: assignmentId, userId },
    include: {
      task: { select: { status: true, isGold: true } },
      project: { select: { goldFeedback: true } },
      _count: { select: { reviews: true } },
    },
  });
  if (!row) return null;
  const later = row.submittedAt
    ? await db.assignment.count({
        where: {
          projectId: row.projectId,
          userId,
          status: 'SUBMITTED',
          id: { not: row.id },
          submittedAt: { gt: row.submittedAt },
        },
      })
    : 0;
  return {
    status: row.status,
    reviewStatus: row.reviewStatus,
    submittedAt: row.submittedAt,
    reviewed: row._count.reviews > 0,
    held:
      row.reviewHeldById !== null &&
      row.reviewHeldAt !== null &&
      row.reviewHeldAt > holdCutoff(now),
    taskStatus: row.task.status,
    isGold: row.task.isGold,
    goldFeedback: row.project.goldFeedback,
    takenBackAt: row.takenBackAt,
    latest: later === 0,
  };
}

/**
 * The annotator takes back what they just handed in, to change it. The
 * submission becomes work they revise on `/my-work/:id`, the same state as
 * work a reviewer sent back (`SENT_BACK`, revised from the moment of the
 * take-back), marked as their own doing (`takenBackAt`) and remembering the
 * review status it had (`takenBackFrom`), which the resubmission returns to:
 * the review draw made at submission is kept. The credited time and the
 * frozen rate stay; revising adds time within the revision cap. The answer
 * becomes the draft the revise page starts from.
 *
 * The rule is `takeBackRefusal`, checked under the task row's lock, and the
 * write repeats every part of it that another transaction could change in
 * its `where`: still the same review status, not taken back, no review, no
 * live hold. Lock order: the task row, then the assignment row. No time is
 * credited, so the work clock is not taken.
 */
export async function takeBackSubmission(
  assignmentId: string,
  userId: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: TakeBackRefusal | 'not_found' }> {
  return retryOnLockConflict(() =>
    prisma.$transaction(async (tx) => {
      await lockTaskOfAssignment(tx, assignmentId);
      const state = await takeBackState(tx, assignmentId, userId, now);
      if (!state) return { ok: false, error: 'not_found' } as const;
      const refused = takeBackRefusal(state, now);
      if (refused) return { ok: false, error: refused } as const;
      const from = state.reviewStatus as 'PENDING' | 'NOT_REQUIRED';
      const current = await tx.assignment.findUniqueOrThrow({
        where: { id: assignmentId },
        select: { answer: true },
      });
      const taken = await tx.assignment.updateMany({
        where: {
          id: assignmentId,
          userId,
          status: 'SUBMITTED',
          reviewStatus: from,
          takenBackAt: null,
          reviews: { none: {} },
          OR: [{ reviewHeldById: null }, { reviewHeldAt: { lte: holdCutoff(now) } }],
        },
        data: {
          reviewStatus: 'SENT_BACK',
          reviewedAt: now,
          payableAt: null,
          takenBackAt: now,
          takenBackFrom: from,
          reviewHeldById: null,
          reviewHeldAt: null,
          draft: current.answer ?? Prisma.DbNull,
          draftSeconds: 0,
        },
      });
      if (taken.count === 0) return { ok: false, error: 'reviewed' } as const;
      return { ok: true } as const;
    }),
  );
}
