import { processDueJobs, startJobLoop, type JobHandlers, type JobLoop } from '~/lib/jobs.server';

import { PRELABEL_JOB, prelabelJob } from './prelabel.server';

/** Every kind of background job, with the handler that runs it. */
export const JOB_HANDLERS: JobHandlers = {
  [PRELABEL_JOB]: prelabelJob,
};

/** Runs the jobs that are due at `now`, with every handler. The tests call this in place of timers. */
export function runDueJobs(now: Date = new Date(), options?: Parameters<typeof processDueJobs>[2]) {
  return processDueJobs(JOB_HANDLERS, now, options);
}

/** Starts this process's job loop with every handler. */
export function startJobs(): JobLoop {
  return startJobLoop(JOB_HANDLERS);
}

/**
 * Whether the web process runs the loop too. `JOBS_IN_WEB=false` leaves the
 * jobs to the `worker` service.
 */
export function jobsInWeb(): boolean {
  return process.env.JOBS_IN_WEB !== 'false';
}

/**
 * The worker: the loop and nothing else. On SIGTERM it takes no more jobs,
 * lets the one it runs finish and exits; a kill before that leaves the
 * lease to run out, and another process takes the job.
 */
export async function runJobWorker(): Promise<void> {
  const loop = startJobs();
  // the loop's timer does not hold the process; this does, until a signal
  const alive = setInterval(() => {}, 1 << 30);
  console.log('job worker started');
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve());
  });
  console.log('job worker stopping');
  clearInterval(alive);
  await loop.stop();
  const { prisma } = await import('~/lib/db.server');
  await prisma.$disconnect();
}
