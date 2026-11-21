import { randomUUID } from 'node:crypto';

import type { Job } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { errorText, retryDelayMs } from '~/domain/jobs';

import { prisma } from './db.server';

/**
 * Background jobs, kept in the `Job` table so that they survive a restart and
 * so that several processes can share them.
 *
 * - A loop takes due jobs with `FOR UPDATE SKIP LOCKED` in one statement of
 *   its own, which sets a lease (`lockedUntil`) and counts the attempt. Two
 *   loops never take the same job while its lease holds.
 * - The handler that `JobHandlers` names for the kind runs outside any
 *   transaction of the loop, so the loop never holds a lock while a handler
 *   takes the task and assignment locks of the claim path.
 * - Done, the job gets `doneAt`. Failed, it is put back with a growing delay
 *   until `maxAttempts`, then gets `failedAt` and the handler's `giveUp`.
 * - A lease that runs out while a handler still works lets another loop take
 *   the job, so a handler must be safe to run twice. Finishing and putting
 *   back check the attempt they belong to, so a late run cannot undo what a
 *   newer one wrote.
 */

/** How long a taken job is left alone before another loop may take it. */
export const LEASE_MS = 60_000;
/** How often an idle loop looks for due jobs. */
export const POLL_MS = 5_000;

export type JobHandler = {
  run: (payload: unknown, job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>) => Promise<void>;
  /** after the last attempt failed */
  giveUp?: (payload: unknown, error: string) => Promise<void>;
};

export type JobHandlers = Readonly<Record<string, JobHandler>>;

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Adds a job. With a `key`, a job with the same key that is not finished yet
 * makes this a no-op, so a batch has one run of its rule waiting at most. Pass
 * the transaction that makes the change the job belongs to, so both commit
 * together. The key is guarded by an advisory lock taken last in that
 * transaction; nothing else waits on it while holding other locks.
 */
export async function enqueueJob(
  db: Db,
  input: {
    kind: string;
    payload: Prisma.InputJsonValue;
    key?: string;
    runAt?: Date;
    maxAttempts?: number;
  },
): Promise<{ id: string; added: boolean }> {
  const add = async (tx: Prisma.TransactionClient) => {
    if (input.key) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.key}))`;
      const open = await tx.job.findFirst({
        where: { key: input.key, doneAt: null, failedAt: null },
        select: { id: true },
      });
      if (open) return { id: open.id, added: false };
    }
    const job = await tx.job.create({
      data: {
        kind: input.kind,
        payload: input.payload,
        key: input.key ?? null,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
      },
      select: { id: true },
    });
    return { id: job.id, added: true };
  };
  return '$transaction' in db ? db.$transaction(add) : add(db);
}

/** Takes up to `limit` due jobs for `workerId` and leases them until `now + leaseMs`. */
export async function takeJobs(
  now: Date,
  workerId: string,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<Job[]> {
  const until = new Date(now.getTime() + (options.leaseMs ?? LEASE_MS));
  return prisma.$queryRaw<Job[]>`
    UPDATE "Job" SET "lockedUntil" = ${until}, "lockedBy" = ${workerId}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "Job"
      WHERE "doneAt" IS NULL AND "failedAt" IS NULL AND "runAt" <= ${now}
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
      ORDER BY "runAt", id
      LIMIT ${options.limit ?? 10}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

/** Runs one taken job and records how it went. */
async function runJob(handlers: JobHandlers, job: Job, now: () => Date): Promise<boolean> {
  // this attempt only: a newer one, after the lease ran out, owns the job
  const mine = { id: job.id, attempts: job.attempts };
  const handler = handlers[job.kind];
  try {
    if (!handler) throw new Error(`No handler for jobs of kind "${job.kind}".`);
    await handler.run(job.payload, job);
    await prisma.job.updateMany({
      where: mine,
      data: { doneAt: now(), lockedUntil: null, lockedBy: null },
    });
    return true;
  } catch (error) {
    const message = errorText(error);
    const last = job.attempts >= job.maxAttempts;
    const at = now();
    const put = await prisma.job.updateMany({
      where: mine,
      data: last
        ? { failedAt: at, lastError: message, lockedUntil: null, lockedBy: null }
        : {
            lastError: message,
            runAt: new Date(at.getTime() + retryDelayMs(job.attempts)),
            lockedUntil: null,
            lockedBy: null,
          },
    });
    if (last && put.count > 0 && handler?.giveUp) {
      await handler.giveUp(job.payload, message).catch((e: unknown) => console.error(e));
    }
    if (!last || put.count === 0) return false;
    console.error(`job ${job.id} (${job.kind}) gave up after ${job.attempts} attempts: ${message}`);
    return false;
  }
}

/**
 * Takes the jobs that are due at `now` and runs them one after the other.
 * The loop calls this, and so do the tests, in place of timers. Returns how
 * many it took and how many of those worked.
 */
export async function processDueJobs(
  handlers: JobHandlers,
  now: Date = new Date(),
  options: { workerId?: string; limit?: number; leaseMs?: number; clock?: () => Date } = {},
): Promise<{ taken: number; done: number }> {
  const jobs = await takeJobs(now, options.workerId ?? workerName(), options);
  let done = 0;
  for (const job of jobs) {
    if (await runJob(handlers, job, options.clock ?? (() => new Date()))) done += 1;
  }
  return { taken: jobs.length, done };
}

let name: string | null = null;
/** This process's name on the jobs it holds: host, pid and a random part. */
export function workerName(): string {
  name ??= `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;
  return name;
}

export type JobLoop = {
  /** takes no more jobs; resolves once the jobs it is running have finished */
  stop: () => Promise<void>;
  wake: () => void;
};

declare global {
  var __jobLoop: JobLoop | undefined;
}

/**
 * Starts the loop of this process: it looks for due jobs every `POLL_MS`, at
 * once again after it found some, and at once when `wakeJobs` is called. One
 * loop per process; a second call returns the first. After `stop` (the
 * callers call it on SIGTERM) it takes no more jobs. A job it is running
 * finishes, or the process is killed first and its lease runs out, and then
 * another process takes it.
 */
export function startJobLoop(handlers: JobHandlers, pollMs = POLL_MS): JobLoop {
  if (globalThis.__jobLoop) return globalThis.__jobLoop;
  let stopped = false;
  let busy: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, ms);
    // a waiting loop does not keep the process alive
    timer.unref();
  };
  const tick = () => {
    if (stopped || busy) return;
    busy = (async () => {
      let again = false;
      try {
        again = (await processDueJobs(handlers)).taken > 0;
      } catch (error) {
        console.error('the job loop could not take jobs', error);
      }
      busy = null;
      schedule(again ? 0 : pollMs);
    })();
  };
  const loop: JobLoop = {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await busy;
    },
    wake: () => {
      if (!busy) schedule(0);
    },
  };
  globalThis.__jobLoop = loop;
  schedule(0);
  return loop;
}

/** Tells this process's loop, if it runs one, that a job was just added. */
export function wakeJobs(): void {
  globalThis.__jobLoop?.wake();
}
