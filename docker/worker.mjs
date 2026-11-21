// The `worker` service: the job loop of the app, without the web server. It
// loads the same server build as the app and runs `runJobWorker` from its
// entry. JOBS_WORKER=true keeps the entry from starting a second loop.
/* global process */
process.env.JOBS_WORKER = 'true';
const build = await import('../build/server/index.js');
await build.entry.module.runJobWorker();
