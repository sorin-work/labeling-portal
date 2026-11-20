import { Prisma, type Assignment, type PayMode, type Project } from '@prisma/client';

import {
  clampActiveSeconds,
  creditHorizon,
  creditTime,
  mergeIntervals,
  revisionCap,
  revisionSeconds,
  type Credit,
  type Interval,
} from '~/domain/active-time';
import { payableSince } from '~/domain/payouts';
import { goldDraw, SESSION_GAP_MINUTES } from '~/domain/queue-order';
import { decideReview, type SamplingDecision } from '~/domain/review-sampling';
import { extensionsLeft, MAX_EXTENSIONS } from '~/domain/time-limit';
import { prisma, utc } from '~/lib/db.server';

import { blockedByDispute } from './disputes.server';
import { scoreGoldSubmission } from './gold.server';
import { isAnnotatorFlagged } from './quality.server';
import { refreshTaskStatus } from './tasks.server';

export type ClaimResult =
  | { ok: true; assignment: Assignment; resumed: boolean }
  | { ok: false; reason: 'inactive' | 'empty' | 'unqualified' };

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
 * claims and submissions than `overlap`. A completed task and the gold tasks
 * copied from it are one group: someone who has labeled, skipped or holds any
 * task of the group gets none of the others, because seeing the same item
 * twice would tell them it is gold.
 *
 * This is the whole rule for "may this annotator be given this task". The
 * pick, the check under the lock and the count on the dashboard all use it.
 */
function eligibleFor(userId: string, now: Date, overlap: Prisma.Sql): Prisma.Sql {
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
    AND (
      t."isGold"
      OR (
        SELECT count(*) FROM "Assignment" a
        WHERE a."taskId" = t.id
          AND (a.status = 'SUBMITTED' OR (a.status = 'ACTIVE' AND a."expiresAt" > ${utc(now)}))
      ) < ${overlap}
    )
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
  /** wait for tasks another annotator is claiming right now instead of passing over them */
  wait?: boolean;
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
  const { project, userId, now, secret, wait = false } = options;
  const lock = wait ? Prisma.sql`FOR UPDATE OF t` : Prisma.sql`FOR UPDATE OF t SKIP LOCKED`;
  const eligible = eligibleFor(userId, now, Prisma.sql`${project.overlap}`);
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
    SELECT pick.id
    FROM (
      SELECT want.gold
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
  const rows = await tx.$queryRaw<Array<{ id: string }>>(nextTaskSql(options));
  return rows[0]?.id ?? null;
}

/**
 * Marks claims that ran past their time limit as expired so the task goes back
 * to the queue. Runs lazily whenever someone asks for work.
 */
export async function releaseExpiredClaims(projectId?: string, now = new Date()): Promise<number> {
  const result = await prisma.assignment.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now }, ...(projectId ? { projectId } : {}) },
    data: { status: 'EXPIRED', ...NO_DRAFT },
  });
  return result.count;
}

/** How many tasks the annotator could still pick up in each project. */
export async function countAvailable(
  projectIds: string[],
  userId: string,
  now = new Date(),
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ projectId: string; count: bigint }>>`
    SELECT t."projectId", count(*) AS count
    FROM "Task" t
    JOIN "Project" p ON p.id = t."projectId"
    WHERE t."projectId" IN (${Prisma.join(projectIds)})
      AND ${eligibleFor(userId, now, Prisma.sql`p.overlap`)}
    GROUP BY t."projectId"`;
  return new Map(rows.map((r) => [r.projectId, Number(r.count)]));
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
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const outcome = await prisma.$transaction(async (tx) => {
      // The pick locks the task and passes over tasks that are being claimed
      // by someone else right now. Only when that leaves nothing does it wait
      // for those: a task with two slots may still have one for us.
      const taskId =
        (await pickNextTask(tx, pick)) ?? (await pickNextTask(tx, { ...pick, wait: true }));
      if (!taskId) return 'empty' as const;
      // With the row locked, look again in a statement of its own. The pick
      // counted the task's claims in its snapshot, and a claim that was
      // committed between that count and our lock is only visible now.
      const [check] = await tx.$queryRaw<Array<{ eligible: boolean }>>`
        SELECT ${eligibleFor(userId, now, Prisma.sql`${project.overlap}`)} AS eligible
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
    });
    if (outcome === 'empty') return { ok: false, reason: 'empty' };
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
    const expired = await prisma.assignment.updateMany({
      where: { id: assignmentId, status: 'ACTIVE' },
      data: { status: 'EXPIRED', ...NO_DRAFT },
    });
    return { ok: false, error: expired.count > 0 ? 'expired' : 'not_active' };
  }

  // gold tasks are scored against their known answer instead of being reviewed
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: found.assignment.taskId },
    include: { project: { select: { schema: true, orgId: true } } },
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
  const assignment = await prisma.$transaction(async (tx) => {
    // The person's clock first, in every transaction that credits time: the
    // claim is credited only the minutes of its window that no other work of
    // theirs has been credited, so the same minutes are not paid twice.
    const clock = await lockWorkClock(tx, task.project.orgId, userId, now);
    const credit = creditTime({
      reported: clock ? input.activeSeconds : 0,
      start: found.assignment.claimedAt,
      now,
      credited: clock?.credited ?? [],
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
  });
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
  const skipped = await prisma.assignment.updateMany({
    where: { id: assignmentId, status: 'ACTIVE' },
    data: { status: 'SKIPPED', skipReason: reason, ...NO_DRAFT },
  });
  return skipped.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
}

/** What crediting a revision needs to know about the submission. */
const REVISION_FIELDS = {
  reviewedAt: true,
  submittedAt: true,
  activeSeconds: true,
  draftSeconds: true,
  project: { select: { timeLimitMinutes: true, orgId: true } },
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
  return prisma.$transaction(async (tx) => {
    if (await blockedByDispute(tx, assignmentId)) return { ok: false, error: 'disputed' };
    const sentBack: Prisma.AssignmentWhereInput = {
      id: assignmentId,
      userId,
      status: 'SUBMITTED',
      reviewStatus: 'SENT_BACK',
    };
    const current = await tx.assignment.findFirst({ where: sentBack, select: REVISION_FIELDS });
    const clock = current ? await lockWorkClock(tx, current.project.orgId, userId, now) : null;
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
    const result = await tx.assignment.updateMany({
      // still sent back: a form posted twice adds its time only once
      where: sentBack,
      data: {
        answer: input.answer,
        reviewStatus: 'PENDING',
        submittedAt: now,
        reviewedAt: null,
        payableAt: null,
        activeSeconds: { increment: credit.seconds },
        ...NO_DRAFT,
      },
    });
    if (result.count > 0) await recordCredit(tx, clock, credit, now);
    if (result.count === 0) {
      const exists = await tx.assignment.count({ where: { id: assignmentId, userId } });
      return { ok: false, error: exists ? 'not_active' : 'not_found' };
    }
    return { ok: true };
  });
}

/** Hands a claim back without an answer so someone else can take it. */
export async function releaseAssignment(
  assignmentId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const released = await prisma.assignment.updateMany({
    where: { id: assignmentId, status: 'ACTIVE' },
    data: { status: 'RELEASED', ...NO_DRAFT },
  });
  return released.count > 0 ? { ok: true } : { ok: false, error: 'not_active' };
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
 * `MAX_EXTENSIONS` times, and only before the claim has run out. The update
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
  | { ok: false; error: AssignmentError | 'no_extensions_left' }
> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const { assignment } = found;
  if (assignment.expiresAt <= now) return { ok: false, error: 'expired' };
  if (assignment.extensions >= MAX_EXTENSIONS) return { ok: false, error: 'no_extensions_left' };
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
