import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';

import { isLockConflict, retryOnLockConflict } from '~/lib/db.server';
import {
  claimNextTask,
  releaseAssignment,
  releaseExpiredClaims,
  resubmitAssignment,
  skipAssignment,
  submitAssignment,
} from '~/models/queue.server';
import { holdReview, recordReview } from '~/models/reviews.server';

import {
  addToProject,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  prisma,
  resetDb,
} from './helpers';

/**
 * Holds a lock in a transaction of its own (a second connection) until
 * `release` is called. `ready` resolves once the lock is held.
 */
function hold(sql: Prisma.Sql) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const ready = new Promise<void>((resolve) => (held = resolve));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(sql);
      held();
      await released;
    },
    { timeout: 20_000 },
  );
  return { ready, release, done };
}

/** Whether a row can be locked right now from a third connection. */
async function lockable(sql: Prisma.Sql): Promise<boolean> {
  try {
    await prisma.$transaction((tx) => tx.$queryRaw(sql));
    return true;
  } catch (error) {
    if (String(error).includes('55P03') || String(error).includes('could not obtain lock')) {
      return false;
    }
    throw error;
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function setup(gold = false) {
  const org = await createOrg();
  const project = await createTestProject(org.id, { overlap: 2, reviewRequired: false });
  const tasks = await createTasks(project.id, [{ text: 'a' }, { text: 'b' }]);
  if (gold) {
    await prisma.task.updateMany({
      where: { projectId: project.id },
      data: { isGold: true, goldAnswer: { labels: ['positive'] } },
    });
  }
  const ann = await createMember(org.id, 'ANNOTATOR');
  const ben = await createMember(org.id, 'ANNOTATOR');
  await addToProject(project.id, ann, ben);
  return { org, project, tasks, ann, ben };
}

const taskLock = (id: string) =>
  Prisma.sql`SELECT id FROM "Task" WHERE id = ${id} FOR NO KEY UPDATE`;
const assignmentProbe = (id: string) =>
  Prisma.sql`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE NOWAIT`;

describe('the task row before the assignment row', () => {
  beforeEach(resetDb);

  for (const [name, act] of [
    ['a skip', (id: string, userId: string) => skipAssignment(id, userId, 'Other: x')],
    ['a release', (id: string, userId: string) => releaseAssignment(id, userId)],
    [
      'a submission',
      (id: string, userId: string) =>
        submitAssignment(id, userId, {
          answer: { labels: ['positive'] },
          activeSeconds: 1,
          reviewRequired: false,
        }),
    ],
  ] as const) {
    it(`${name} waits for the task row before it touches the assignment`, async () => {
      const { project, ann } = await setup(name === 'a submission');
      const claim = await claimNextTask(project, ann.id, new Date(Date.now() - 60_000));
      if (!claim.ok) throw new Error('no claim');
      const holder = hold(taskLock(claim.assignment.taskId));
      await holder.ready;
      const pending = act(claim.assignment.id, ann.id);
      await settle();
      // blocked on the task row, and the assignment row is still free: the
      // order that cannot close a circle with the trigger's task update
      expect(await lockable(assignmentProbe(claim.assignment.id))).toBe(true);
      holder.release();
      await holder.done;
      expect((await pending).ok).toBe(true);
    });
  }

  it('a gold submission holds its task row against every other writer', async () => {
    const { project, ann } = await setup(true);
    const claim = await claimNextTask(project, ann.id, new Date(Date.now() - 60_000));
    if (!claim.ok) throw new Error('no claim');
    // keep the assignment row busy, so the submission stops right after the task lock
    const holder = hold(
      Prisma.sql`SELECT id FROM "Assignment" WHERE id = ${claim.assignment.id} FOR UPDATE`,
    );
    await holder.ready;
    const pending = submitAssignment(claim.assignment.id, ann.id, {
      answer: { labels: ['positive'] },
      activeSeconds: 1,
      reviewRequired: false,
    });
    await settle();
    // a shared lock, which a skip or an expiry used to get past, is refused now
    expect(
      await lockable(
        Prisma.sql`SELECT id FROM "Task" WHERE id = ${claim.assignment.taskId} FOR SHARE NOWAIT`,
      ),
    ).toBe(false);
    holder.release();
    await holder.done;
    expect((await pending).ok).toBe(true);
  });

  it('expiry locks every task first, in id order, and only then the claims', async () => {
    const { project, tasks, ann, ben } = await setup();
    const t0 = new Date(Date.now() - 3 * 3600_000);
    const first = await claimNextTask(project, ann.id, t0);
    const second = await claimNextTask(project, ben.id, t0);
    if (!first.ok || !second.ok) throw new Error('no claims');
    // both claims on different tasks; hold the one with the larger id
    await prisma.assignment.update({
      where: { id: second.assignment.id },
      data: { taskId: tasks[1].id },
    });
    await prisma.assignment.update({
      where: { id: first.assignment.id },
      data: { taskId: tasks[0].id },
    });
    const [low, high] = [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1));
    const lowClaim = [first, second].find((c) => c.ok && c.assignment.taskId === low.id)!;
    const holder = hold(taskLock(high.id));
    await holder.ready;
    const pending = releaseExpiredClaims(project.id);
    await settle();
    // the lower task is taken, the claims are not touched yet
    expect(
      await lockable(
        Prisma.sql`SELECT id FROM "Task" WHERE id = ${low.id} FOR NO KEY UPDATE NOWAIT`,
      ),
    ).toBe(false);
    expect(lowClaim.ok && (await lockable(assignmentProbe(lowClaim.assignment.id)))).toBe(true);
    holder.release();
    await holder.done;
    expect(await pending).toBe(2);
  });

  it('a revision takes the work clock before the task row, as a submission does', async () => {
    const { org, project, ann } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    const reviewing = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const claim = await claimNextTask(reviewing, ann.id, new Date(Date.now() - 60_000));
    if (!claim.ok) throw new Error('no claim');
    const submitted = await submitAssignment(claim.assignment.id, ann.id, {
      answer: { labels: ['positive'] },
      activeSeconds: 1,
      reviewRequired: true,
    });
    if (!submitted.ok) throw new Error(submitted.error);
    const reviewer = await createMember(org.id, 'REVIEWER');
    const decided = await recordReview(claim.assignment.id, reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: null,
      feedback: 'again',
    });
    expect(decided.ok).toBe(true);

    const holder = hold(taskLock(claim.assignment.taskId));
    await holder.ready;
    const pending = resubmitAssignment(claim.assignment.id, ann.id, {
      answer: { labels: ['negative'] },
      activeSeconds: 1,
    });
    await settle();
    // waiting for the task row: the clock is taken already, the assignment not yet
    expect(
      await lockable(
        Prisma.sql`SELECT id FROM "Membership" WHERE "orgId" = ${org.id} AND "userId" = ${ann.id} FOR NO KEY UPDATE NOWAIT`,
      ),
    ).toBe(false);
    expect(await lockable(assignmentProbe(claim.assignment.id))).toBe(true);
    holder.release();
    await holder.done;
    expect((await pending).ok).toBe(true);
  });

  it('two reviewers taking over each other’s lapsed reservations queue instead of deadlocking', async () => {
    const { org, project, ann, ben } = await setup();
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    const reviewing = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const work = [];
    for (const user of [ann, ben]) {
      const claim = await claimNextTask(reviewing, user.id, new Date(Date.now() - 60_000));
      if (!claim.ok) throw new Error('no claim');
      await submitAssignment(claim.assignment.id, user.id, {
        answer: { labels: ['positive'] },
        activeSeconds: 1,
        reviewRequired: true,
      });
      work.push(claim.assignment.id);
    }
    const [r1, r2] = [
      await createMember(org.id, 'REVIEWER'),
      await createMember(org.id, 'REVIEWER'),
    ];
    // each holds one, long enough ago that the hold has lapsed
    const lapsed = new Date(Date.now() - 3 * 3600_000);
    await prisma.assignment.update({
      where: { id: work[0] },
      data: { reviewHeldById: r1.id, reviewHeldAt: lapsed },
    });
    await prisma.assignment.update({
      where: { id: work[1] },
      data: { reviewHeldById: r2.id, reviewHeldAt: lapsed },
    });
    for (let round = 0; round < 5; round++) {
      const results = await Promise.all([holdReview(work[1], r1.id), holdReview(work[0], r2.id)]);
      expect(results.every((r) => r.ok || r.error !== undefined)).toBe(true);
      // put the lapsed holds back for the next round
      await prisma.assignment.update({
        where: { id: work[0] },
        data: { reviewHeldById: r1.id, reviewHeldAt: lapsed },
      });
      await prisma.assignment.update({
        where: { id: work[1] },
        data: { reviewHeldById: r2.id, reviewHeldAt: lapsed },
      });
    }

    // and the order itself: with the lower row held elsewhere, nothing else is locked yet
    const [low, high] = [...work].sort();
    // the reviewer whose own lapsed hold is the lower row reserves the higher one
    const owner = low === work[0] ? r1 : r2;
    const target = high;
    const holder = hold(Prisma.sql`SELECT id FROM "Assignment" WHERE id = ${low} FOR UPDATE`);
    await holder.ready;
    const pending = holdReview(target, owner.id);
    await settle();
    expect(await lockable(assignmentProbe(high))).toBe(true);
    holder.release();
    await holder.done;
    await pending;
  });

  it('runs a transaction once more when PostgreSQL broke a deadlock', async () => {
    let calls = 0;
    const result = await retryOnLockConflict(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Prisma.PrismaClientKnownRequestError('deadlock detected', {
          code: 'P2010',
          clientVersion: Prisma.prismaVersion.client,
          meta: { code: '40P01' },
        });
      }
      return 'done';
    });
    expect(result).toBe('done');
    expect(calls).toBe(2);
    expect(isLockConflict(new Error('unique constraint failed'))).toBe(false);
    // a lock wait that ran out and a transaction Prisma gave up on are retried too
    for (const [code, meta] of [
      ['P2010', { code: '55P03' }],
      ['P2028', undefined],
    ] as const) {
      expect(
        isLockConflict(
          new Prisma.PrismaClientKnownRequestError('x', {
            code,
            clientVersion: Prisma.prismaVersion.client,
            meta,
          }),
        ),
      ).toBe(true);
    }
    await expect(
      retryOnLockConflict(async () => {
        throw new Error('something else');
      }),
    ).rejects.toThrow('something else');
  });
});
