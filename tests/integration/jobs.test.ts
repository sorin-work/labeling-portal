import { beforeEach, describe, expect, it } from 'vitest';

import {
  enqueueJob,
  LOST_ATTEMPT,
  processDueJobs,
  takeJobs,
  type JobHandlers,
} from '~/lib/jobs.server';

import { prisma, resetDb } from './helpers';

const now = new Date('2026-11-21T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

/** Handlers for a made-up kind that count their runs. */
function counting(options: { fail?: boolean; waitMs?: number } = {}) {
  const runs: unknown[] = [];
  const gaveUp: string[] = [];
  const handlers: JobHandlers = {
    test: {
      async run(payload) {
        runs.push(payload);
        if (options.waitMs) await new Promise((resolve) => setTimeout(resolve, options.waitMs));
        if (options.fail) throw new Error('it broke\nwith a second line');
      },
      async giveUp(_payload, error) {
        gaveUp.push(error);
      },
    },
  };
  return { handlers, runs, gaveUp };
}

describe('background jobs', () => {
  beforeEach(resetDb);

  it('two loops never run one job', async () => {
    const { handlers, runs } = counting({ waitMs: 50 });
    await enqueueJob(prisma, { kind: 'test', payload: { n: 1 }, runAt: now });
    const [a, b] = await Promise.all([
      processDueJobs(handlers, now, { workerId: 'a', clock: () => now }),
      processDueJobs(handlers, now, { workerId: 'b', clock: () => now }),
    ]);
    expect(a.taken + b.taken).toBe(1);
    expect(runs).toEqual([{ n: 1 }]);
    const job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ doneAt: now, attempts: 1, lockedUntil: null, lockedBy: null });
    // done is done
    expect((await processDueJobs(handlers, later(3_600_000))).taken).toBe(0);
  });

  it('waits for its time', async () => {
    const { handlers, runs } = counting();
    await enqueueJob(prisma, { kind: 'test', payload: {}, runAt: later(60_000) });
    expect((await processDueJobs(handlers, now)).taken).toBe(0);
    expect((await processDueJobs(handlers, later(60_000))).taken).toBe(1);
    expect(runs).toHaveLength(1);
  });

  it('puts a failed job back with a growing delay and stops after its attempts', async () => {
    const { handlers, runs, gaveUp } = counting({ fail: true });
    await enqueueJob(prisma, { kind: 'test', payload: {}, runAt: now, maxAttempts: 2 });

    await processDueJobs(handlers, now, { clock: () => now });
    let job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({
      attempts: 1,
      lastError: 'it broke',
      runAt: later(30_000),
      doneAt: null,
      failedAt: null,
      lockedUntil: null,
    });
    // not before its time
    expect((await processDueJobs(handlers, later(10_000))).taken).toBe(0);

    await processDueJobs(handlers, later(30_000), { clock: () => later(30_000) });
    job = await prisma.job.findFirstOrThrow();
    expect(job).toMatchObject({ attempts: 2, failedAt: later(30_000), doneAt: null });
    expect(gaveUp).toEqual(['it broke']);
    expect((await processDueJobs(handlers, later(24 * 3_600_000))).taken).toBe(0);
    expect(runs).toHaveLength(2);
  });

  it('takes a job again once the lease of a loop that died has run out', async () => {
    const { handlers, runs } = counting();
    await enqueueJob(prisma, { kind: 'test', payload: {}, runAt: now });
    // a loop takes it and is never heard of again
    expect(await takeJobs(now, 'gone', { leaseMs: 60_000 })).toHaveLength(1);
    expect((await processDueJobs(handlers, later(59_000))).taken).toBe(0);
    expect((await processDueJobs(handlers, later(60_000), { workerId: 'b' })).taken).toBe(1);
    expect(runs).toHaveLength(1);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ attempts: 2 });
    expect((await prisma.job.findFirstOrThrow()).doneAt).not.toBeNull();
  });

  it('fails a job whose last attempt was killed instead of taking it again', async () => {
    const { handlers, runs, gaveUp } = counting();
    await enqueueJob(prisma, { kind: 'test', payload: {}, runAt: now, maxAttempts: 2 });
    // two loops in a row take it and die
    await takeJobs(now, 'gone-1', { leaseMs: 60_000 });
    await takeJobs(later(60_000), 'gone-2', { leaseMs: 60_000 });
    const result = await processDueJobs(handlers, later(120_000));
    expect(result.taken).toBe(0);
    expect(runs).toHaveLength(0);
    expect(gaveUp).toEqual([LOST_ATTEMPT]);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({
      attempts: 2,
      failedAt: later(120_000),
      lastError: LOST_ATTEMPT,
      lockedBy: null,
    });
  });

  it('renews the lease while a handler works, so nobody else takes the job', async () => {
    let seenByOther = -1;
    const handlers: JobHandlers = {
      test: {
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 120));
          // the first lease (40 ms) has run out by now; the renewed one has not
          seenByOther = (await takeJobs(new Date(), 'b')).length;
        },
      },
    };
    await enqueueJob(prisma, { kind: 'test', payload: {} });
    await processDueJobs(handlers, new Date(), { leaseMs: 40, heartbeatMs: 10 });
    expect(seenByOther).toBe(0);
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({ attempts: 1 });
    expect((await prisma.job.findFirstOrThrow()).doneAt).not.toBeNull();
  });

  it('a late run cannot undo what the newer run wrote', async () => {
    const { handlers } = counting({ fail: true, waitMs: 30 });
    await enqueueJob(prisma, { kind: 'test', payload: {}, runAt: now, maxAttempts: 5 });
    // the first loop's lease is short and runs out while its handler still works
    const first = processDueJobs(handlers, now, { workerId: 'a', leaseMs: 1, clock: () => now });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.job.updateMany({ data: { lastError: null } });
    const [taken] = await takeJobs(later(1), 'b');
    expect(taken.attempts).toBe(2);
    await first;
    // the failure of attempt 1 did not put back the job that b holds now
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({
      lockedBy: 'b',
      attempts: 2,
      lastError: null,
    });
  });

  it('keeps one open job per key, and fails a kind nobody handles', async () => {
    const first = await enqueueJob(prisma, { kind: 'nobody', payload: {}, key: 'k', runAt: now });
    const again = await enqueueJob(prisma, { kind: 'nobody', payload: {}, key: 'k', runAt: now });
    expect(again).toEqual({ id: first.id, added: false });
    expect(await prisma.job.count()).toBe(1);

    await processDueJobs({}, now, { clock: () => now });
    expect(await prisma.job.findFirstOrThrow()).toMatchObject({
      lastError: 'No handler for jobs of kind "nobody".',
      doneAt: null,
    });
    await prisma.job.updateMany({ data: { doneAt: now } });
    expect(
      (await enqueueJob(prisma, { kind: 'nobody', payload: {}, key: 'k', runAt: now })).added,
    ).toBe(true);
  });

  it('commits with the transaction it was added in, or not at all', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueJob(tx, { kind: 'test', payload: {}, key: 'gone', runAt: now });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await prisma.job.count()).toBe(0);
  });
});
