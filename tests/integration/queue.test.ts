import { beforeEach, describe, expect, it } from 'vitest';

import { emptyAnswer } from '~/domain/answers';
import { DRAFT_MAX_BYTES } from '~/domain/drafts';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { payoutReport } from '~/models/payouts.server';
import {
  claimNextTask,
  clampActiveSeconds,
  countAvailable,
  extendAssignment,
  releaseAssignment,
  releaseClaim,
  releaseExpiredClaims,
  saveDraft,
  skipAssignment,
  submitAssignment,
} from '~/models/queue.server';
import { action as workAction, loader as workLoader } from '~/routes/work';
import { action as draftAction } from '~/routes/work-draft';
import { action as claimAction } from '~/routes/project-work';
import { action as taskAction } from '~/routes/task-detail';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  locationOf,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
} from './helpers';

async function setup(overlap = 1) {
  const org = await createOrg();
  const project = await createTestProject(org.id, { overlap });
  const tasks = await createTasks(project.id, [
    { text: 'one' },
    { text: 'two' },
    { text: 'three' },
  ]);
  const ann = await createMember(org.id, 'ANNOTATOR');
  await addToProject(project.id, ann);
  return { org, project, tasks, ann, cookie: await cookieFor(ann, org.id) };
}

describe('task queue', () => {
  beforeEach(resetDb);

  it('claims tasks in position order', async () => {
    const { project, tasks, ann } = await setup();
    const result = await claimNextTask(project, ann.id);
    expect(result.ok && result.assignment.taskId).toBe(tasks[0].id);
    expect(
      result.ok && result.assignment.expiresAt.getTime() - result.assignment.claimedAt.getTime(),
    ).toBe(30 * 60_000);
  });

  it('resumes the current claim instead of taking another task', async () => {
    const { project, ann } = await setup();
    const first = await claimNextTask(project, ann.id);
    const second = await claimNextTask(project, ann.id);
    expect(second).toMatchObject({ ok: true, resumed: true });
    expect(second.ok && first.ok && second.assignment.id === first.assignment.id).toBe(true);
  });

  it('gives each task to at most `overlap` annotators', async () => {
    const { org, project, tasks, ann } = await setup(2);
    const b = await createMember(org.id, 'ANNOTATOR');
    const c = await createMember(org.id, 'ANNOTATOR');

    const claims = [];
    for (const user of [ann, b, c]) claims.push(await claimNextTask(project, user.id));

    const taskIds = claims.map((c) => (c.ok ? c.assignment.taskId : null));
    expect(taskIds).toEqual([tasks[0].id, tasks[0].id, tasks[1].id]);
  });

  it('never gives the last slot of a task to two people claiming at once', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 1 });
    const [task] = await createTasks(project.id, [{ text: 'only one' }]);
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await createMember(org.id, 'ANNOTATOR'));

    const results = await Promise.all(users.map((u) => claimNextTask(project, u.id)));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'empty')).toBe(true);
    expect(await prisma.assignment.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('does not hand out paused projects', async () => {
    const { project, ann } = await setup();
    const paused = await prisma.project.update({
      where: { id: project.id },
      data: { status: 'PAUSED' },
    });
    expect(await claimNextTask(paused, ann.id)).toEqual({ ok: false, reason: 'inactive' });
  });

  it('reports an empty queue', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    const ann = await createMember(org.id, 'ANNOTATOR');
    expect(await claimNextTask(project, ann.id)).toEqual({ ok: false, reason: 'empty' });
  });

  it('clamps reported working time to the time since the claim', () => {
    const claimed = new Date('2026-01-01T10:00:00Z');
    const now = new Date('2026-01-01T10:02:00Z');
    expect(clampActiveSeconds(90, claimed, now)).toBe(90);
    expect(clampActiveSeconds(9999, claimed, now)).toBe(120);
    expect(clampActiveSeconds(-5, claimed, now)).toBe(0);
    expect(clampActiveSeconds(Number.NaN, claimed, now)).toBe(0);
  });
});

describe('work routes', () => {
  beforeEach(resetDb);

  it('claims through the project work action and opens the task', async () => {
    const { project, cookie, tasks } = await setup();

    const result = await run(
      claimAction,
      makeRequest(`/projects/${project.id}/work`, { cookie, form: {} }),
      {
        projectId: project.id,
      },
    );
    const assignment = await prisma.assignment.findFirstOrThrow();
    expect(locationOf(result)).toBe(`/work/${assignment.id}`);

    const page = await run(workLoader, makeRequest(`/work/${assignment.id}`, { cookie }), {
      assignmentId: assignment.id,
    });
    // the page gets the task's content, not its id (see the gold tests)
    expect(assignment.taskId).toBe(tasks[0].id);
    expect(payload<{ task: Record<string, unknown> }>(page).task).toEqual({
      ref: assignment.id.slice(-6).toUpperCase(),
      batch: 'batch',
      data: { text: 'one' },
    });
  });

  it('submits a valid answer and moves on to the next task', async () => {
    const { project, ann, cookie, tasks } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    const result = await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: {
          intent: 'submit',
          answer: JSON.stringify({ labels: ['positive'] }),
          activeSeconds: '12',
        },
      }),
      { assignmentId: id },
    );

    const submitted = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(submitted).toMatchObject({ status: 'SUBMITTED', answer: { labels: ['positive'] } });
    const next = await prisma.assignment.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    expect(next.taskId).toBe(tasks[1].id);
    expect(locationOf(result)).toBe(`/work/${next.id}`);
  });

  it('takes an entity task with nothing marked as an answer', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { schema: SCHEMA_TEMPLATES.ner });
    await createTasks(project.id, [{ text: 'Nothing to tag in this sentence.' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    // what the work page posts when the annotator marked nothing
    const answer = JSON.stringify(emptyAnswer(SCHEMA_TEMPLATES.ner));
    await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie: await cookieFor(ann, org.id),
        form: { intent: 'submit', answer },
      }),
      { assignmentId: id },
    );

    const submitted = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(submitted).toMatchObject({ status: 'SUBMITTED', answer: { spans: [] } });
  });

  it('rejects an invalid answer', async () => {
    const { project, ann, cookie } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    const result = await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'submit', answer: '{"labels":["nope"]}' },
      }),
      { assignmentId: id },
    );

    expect(statusOf(result)).toBe(400);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
  });

  it('skips with a reason and never offers the task again', async () => {
    const { project, ann, cookie, tasks } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'skip', reason: 'Content is broken or unreadable', detail: '' },
      }),
      { assignmentId: id },
    );

    const skipped = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(skipped).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'Content is broken or unreadable',
    });
    const active = await prisma.assignment.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    expect(active.taskId).toBe(tasks[1].id);
  });

  it('flags instructions that changed after the last submission', async () => {
    const { project, ann, cookie } = await setup();
    const first = await claimNextTask(project, ann.id);
    const firstId = first.ok ? first.assignment.id : '';
    await run(
      workAction,
      makeRequest(`/work/${firstId}`, {
        cookie,
        form: { intent: 'submit', answer: '{"labels":["positive"]}' },
      }),
      { assignmentId: firstId },
    );
    const next = await prisma.assignment.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const before = await run(workLoader, makeRequest(`/work/${next.id}`, { cookie }), {
      assignmentId: next.id,
    });
    expect(payload<{ instructionsChanged: boolean }>(before).instructionsChanged).toBe(false);

    await prisma.project.update({
      where: { id: project.id },
      data: { instructionsUpdatedAt: new Date() },
    });
    const after = await run(workLoader, makeRequest(`/work/${next.id}`, { cookie }), {
      assignmentId: next.id,
    });
    expect(payload<{ instructionsChanged: boolean }>(after).instructionsChanged).toBe(true);
  });

  it('needs details when skipping for another reason', async () => {
    const { project, ann, cookie } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    const result = await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'skip', reason: 'Other', detail: ' ' },
      }),
      { assignmentId: id },
    );
    expect(statusOf(result)).toBe(400);
  });

  it("does not open another annotator's task", async () => {
    const { org, project, ann } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';
    const other = await createMember(org.id, 'ANNOTATOR');

    const result = await run(
      workLoader,
      makeRequest(`/work/${id}`, { cookie: await cookieFor(other, org.id) }),
      {
        assignmentId: id,
      },
    );
    expect(statusOf(result)).toBe(404);
  });
});

describe('expired claims', () => {
  beforeEach(resetDb);

  it('puts abandoned claims back in the queue', async () => {
    const { org, project, ann, tasks } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    await claimNextTask(project, ann.id, t0);

    const other = await createMember(org.id, 'ANNOTATOR');
    const later = new Date(t0.getTime() + 31 * 60_000);
    const claim = await claimNextTask(project, other.id, later);

    expect(claim.ok && claim.assignment.taskId).toBe(tasks[0].id);
    const old = await prisma.assignment.findFirstOrThrow({ where: { userId: ann.id } });
    expect(old.status).toBe('EXPIRED');
  });

  it('refuses a submission that arrives after the time limit', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';

    const late = await submitAssignment(
      id,
      ann.id,
      { answer: { labels: ['positive'] }, activeSeconds: 60, reviewRequired: true },
      new Date(t0.getTime() + 31 * 60_000),
    );

    expect(late).toEqual({ ok: false, error: 'expired' });
    const stored = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: 'EXPIRED', answer: null });
  });

  it('keeps a submission that was in time when a second post arrives after the limit', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    const input = { answer: { labels: ['positive'] }, activeSeconds: 60, reviewRequired: true };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 200));

    // Both posts read the claim as active. Holding the row makes them write
    // one after the other: the one in time first, the late one second.
    let inTime: ReturnType<typeof submitAssignment> | undefined;
    let late: ReturnType<typeof submitAssignment> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Assignment" WHERE id = ${id} FOR UPDATE`;
      inTime = submitAssignment(id, ann.id, input, new Date(t0.getTime() + 29 * 60_000));
      await pause();
      late = submitAssignment(id, ann.id, input, new Date(t0.getTime() + 31 * 60_000));
      await pause();
    });

    const [first, second] = [await inTime, await late];
    const stored = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    // whichever write came first, the row and the answers given agree
    if (first?.ok) {
      expect(second).toEqual({ ok: false, error: 'not_active' });
      expect(stored).toMatchObject({ status: 'SUBMITTED', answer: { labels: ['positive'] } });
    } else {
      expect(second).toEqual({ ok: false, error: 'expired' });
      expect(stored).toMatchObject({ status: 'EXPIRED', answer: null });
    }
    expect(first?.ok).toBe(true);
  });

  it('sends the annotator back to the project when their time ran out', async () => {
    const { project, ann, cookie } = await setup();
    const claim = await claimNextTask(project, ann.id, new Date(Date.now() - 40 * 60_000));
    const id = claim.ok ? claim.assignment.id : '';

    const result = await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'submit', answer: '{"labels":["negative"]}' },
      }),
      { assignmentId: id },
    );

    expect(locationOf(result)).toBe(`/projects/${project.id}?queue=expired`);
    expect(await prisma.assignment.count({ where: { status: 'SUBMITTED' } })).toBe(0);
  });

  it('keeps claims that are still within the limit', async () => {
    const { org, project, ann, tasks } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    await claimNextTask(project, ann.id, t0);

    const other = await createMember(org.id, 'ANNOTATOR');
    const claim = await claimNextTask(project, other.id, new Date(t0.getTime() + 29 * 60_000));
    expect(claim.ok && claim.assignment.taskId).toBe(tasks[1].id);
  });
});

describe('more time', () => {
  beforeEach(resetDb);

  it('extends a claim by the time limit, three times at most', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

    expect(await extendAssignment(id, ann.id, 30, at(29))).toEqual({
      ok: true,
      expiresAt: at(60),
      extensionsLeft: 2,
    });
    expect(await extendAssignment(id, ann.id, 30, at(59))).toEqual({
      ok: true,
      expiresAt: at(90),
      extensionsLeft: 1,
    });
    expect(await extendAssignment(id, ann.id, 30, at(89))).toEqual({
      ok: true,
      expiresAt: at(120),
      extensionsLeft: 0,
    });
    expect(await extendAssignment(id, ann.id, 30, at(119))).toEqual({
      ok: false,
      error: 'no_extensions_left',
    });
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(row.extensions).toBe(3);
    expect(row.expiresAt).toEqual(at(120));
  });

  it('counts two requests at the same moment as one extension', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    const now = new Date(t0.getTime() + 29 * 60_000);
    const results = await Promise.all([
      extendAssignment(id, ann.id, 30, now),
      extendAssignment(id, ann.id, 30, now),
    ]);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(row.extensions).toBe(results.filter((r) => r.ok).length);
    expect(row.expiresAt.getTime() - t0.getTime()).toBe(row.extensions * 30 * 60_000 + 30 * 60_000);
  });

  it('only gives more time in the last two minutes, so extensions cannot be stacked', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    // three requests right after claiming: refused, nothing added
    for (const minute of [1, 1, 1]) {
      expect(await extendAssignment(id, ann.id, 30, at(minute))).toEqual({
        ok: false,
        error: 'too_early',
      });
    }
    expect(await extendAssignment(id, ann.id, 30, at(27.9))).toEqual({
      ok: false,
      error: 'too_early',
    });
    // granted at two minutes left; the next one waits for the new last two minutes
    expect((await extendAssignment(id, ann.id, 30, at(28))).ok).toBe(true);
    expect(await extendAssignment(id, ann.id, 30, at(28.5))).toEqual({
      ok: false,
      error: 'too_early',
    });
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect([row.extensions, row.expiresAt]).toEqual([1, at(60)]);
  });

  it('credits a first submission at most two time limits, with every extension used', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { timeLimitMinutes: 480 });
    await createTasks(project.id, [{ text: 'one' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await addToProject(project.id, ann);
    const t0 = new Date(Date.now() - 4 * 480 * 60_000 + 60_000);
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    for (const end of [480, 960, 1440]) {
      expect((await extendAssignment(id, ann.id, 480, at(end - 1))).ok).toBe(true);
    }
    const now = at(4 * 480 - 1);
    const result = await submitAssignment(
      id,
      ann.id,
      { answer: { labels: ['positive'] }, activeSeconds: 4 * 480 * 60, reviewRequired: false },
      now,
    );
    expect(result.ok).toBe(true);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    // nearly four limits passed, all of it inside the credit window; two are credited
    expect(row.activeSeconds).toBe(2 * 480 * 60);
  });

  it('cannot revive a claim that already ran out', async () => {
    const { project, ann } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    const claim = await claimNextTask(project, ann.id, t0);
    const id = claim.ok ? claim.assignment.id : '';
    expect(await extendAssignment(id, ann.id, 30, new Date(t0.getTime() + 31 * 60_000))).toEqual({
      ok: false,
      error: 'expired',
    });
  });
});

describe('releasing a claim', () => {
  beforeEach(resetDb);

  it('returns the task to the queue for other annotators', async () => {
    const { org, project, ann, cookie, tasks } = await setup();
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';

    const result = await run(
      workAction,
      makeRequest(`/work/${id}`, { cookie, form: { intent: 'release' } }),
      {
        assignmentId: id,
      },
    );
    expect(locationOf(result)).toBe(`/projects/${project.id}`);

    const other = await createMember(org.id, 'ANNOTATOR');
    const next = await claimNextTask(project, other.id);
    expect(next.ok && next.assignment.taskId).toBe(tasks[0].id);
  });
});

describe('drafts', () => {
  beforeEach(resetDb);

  type WorkPage = { assignment: { draft: unknown; draftSeconds: number } };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function claimed(minutes = 5) {
    const all = await setup();
    const claim = await claimNextTask(all.project, all.ann.id, minutesAgo(minutes));
    return { ...all, id: claim.ok ? claim.assignment.id : '' };
  }

  function save(id: string, cookie: string, form: Record<string, string>) {
    return run(draftAction, makeRequest(`/work/${id}/draft`, { cookie, form }), {
      assignmentId: id,
    });
  }

  async function open(id: string, cookie: string) {
    const page = await run(workLoader, makeRequest(`/work/${id}`, { cookie }), {
      assignmentId: id,
    });
    return payload<WorkPage>(page).assignment;
  }

  it('saves a draft and gives it back when the page loads again', async () => {
    const { id, cookie } = await claimed();
    expect(await open(id, cookie)).toMatchObject({ draft: null, draftSeconds: 0 });

    const saved = await save(id, cookie, { draft: '{"labels":["negative"]}', activeSeconds: '40' });
    expect(statusOf(saved)).toBe(200);
    expect(await (saved as Response).json()).toEqual({ ok: true, draftSeconds: 40 });

    expect(await open(id, cookie)).toEqual(
      expect.objectContaining({ draft: { labels: ['negative'] }, draftSeconds: 40 }),
    );
  });

  it('stores a draft that is not a valid answer yet', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { schema: SCHEMA_TEMPLATES.pairwise });
    await createTasks(project.id, [{ prompt: 'p', response_a: 'a', response_b: 'b' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    const cookie = await cookieFor(ann, org.id);
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';
    const draft = { preference: null, scores: { a: {}, b: {} }, rationale: 'A is' };

    expect(statusOf(await save(id, cookie, { draft: JSON.stringify(draft) }))).toBe(200);
    expect((await open(id, cookie)).draft).toEqual(draft);

    // handing the same thing in is still refused
    const submitted = await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'submit', answer: JSON.stringify(draft) },
      }),
      { assignmentId: id },
    );
    expect(statusOf(submitted)).toBe(400);
  });

  it('leaves out a box the schema refuses since the draft was saved, and says so', async () => {
    const org = await createOrg();
    const schema = SCHEMA_TEMPLATES.bbox;
    const [label] = schema.labels;
    const project = await createTestProject(org.id, { schema });
    await createTasks(project.id, [{ [schema.imageField]: '/demo/street-1.svg' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    const cookie = await cookieFor(ann, org.id);
    const claim = await claimNextTask(project, ann.id);
    const id = claim.ok ? claim.assignment.id : '';
    const big = { x: 10, y: 10, w: 80, h: 60, label };
    const small = { x: 200, y: 10, w: 12, h: 12, label };
    const draft = { imageWidth: 640, imageHeight: 400, boxes: [big, small] };
    await save(id, cookie, { draft: JSON.stringify(draft) });
    expect(await open(id, cookie)).toMatchObject({ draft, draftNote: null });

    await prisma.project.update({
      where: { id: project.id },
      data: { schema: { ...schema, minBoxSize: 20 } },
    });
    const page = await open(id, cookie);
    expect(page.draft).toEqual({ ...draft, boxes: [big] });
    expect(page).toMatchObject({ draftNote: expect.stringMatching(/^One box from your draft/) });
  });

  it('clamps the working time, never lowers it and keeps the draft on a time-only save', async () => {
    const { id, cookie } = await claimed(2);
    await save(id, cookie, { draft: '{"labels":["positive"]}', activeSeconds: '9999' });
    const first = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(first.draftSeconds).toBeGreaterThanOrEqual(120);
    expect(first.draftSeconds).toBeLessThan(130);

    // another tab that was only looked at reports less time and no answer
    expect(statusOf(await save(id, cookie, { activeSeconds: '10' }))).toBe(200);
    const second = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(second).toMatchObject({
      draft: { labels: ['positive'] },
      draftSeconds: first.draftSeconds,
    });

    // two tabs saving at the same moment: the larger time still stands
    await Promise.all(['30', '5', '60'].map((s) => save(id, cookie, { activeSeconds: s })));
    const third = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(third.draftSeconds).toBe(first.draftSeconds);
  });

  it('refuses a draft that is too large or not a JSON object', async () => {
    const { id, cookie } = await claimed();
    const huge = JSON.stringify({ rationale: 'a'.repeat(DRAFT_MAX_BYTES) });
    expect(statusOf(await save(id, cookie, { draft: huge }))).toBe(413);
    expect(statusOf(await save(id, cookie, { draft: '["positive"]' }))).toBe(400);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).draft).toBeNull();
  });

  it('clears the draft on submit and opens the next task without one', async () => {
    const { id, cookie } = await claimed();
    await save(id, cookie, { draft: '{"labels":["negative"]}', activeSeconds: '30' });

    await run(
      workAction,
      makeRequest(`/work/${id}`, {
        cookie,
        form: { intent: 'submit', answer: '{"labels":["positive"]}', activeSeconds: '45' },
      }),
      { assignmentId: id },
    );
    const done = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(done).toMatchObject({
      status: 'SUBMITTED',
      answer: { labels: ['positive'] },
      activeSeconds: 45,
      draft: null,
      draftSeconds: 0,
    });

    const next = await prisma.assignment.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    expect(await open(next.id, cookie)).toMatchObject({ draft: null, draftSeconds: 0 });
  });

  it('drops the draft when the claim is skipped, released or runs out', async () => {
    const { project, ann } = await setup();
    const endings = [
      (id: string) => skipAssignment(id, ann.id, 'Other: test'),
      (id: string) => releaseAssignment(id, ann.id),
      () => releaseExpiredClaims(project.id, new Date(Date.now() + 60 * 60_000)),
    ];
    for (const end of endings) {
      const claim = await claimNextTask(project, ann.id, minutesAgo(5));
      const id = claim.ok ? claim.assignment.id : '';
      await saveDraft(id, ann.id, { draft: { labels: ['negative'] }, activeSeconds: 20 });
      await end(id);
      const row = await prisma.assignment.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ draft: null, draftSeconds: 0 });
      expect(row.status).not.toBe('ACTIVE');
    }
  });

  it("answers not found for another annotator's assignment", async () => {
    const { org, id } = await claimed();
    const other = await createMember(org.id, 'ANNOTATOR');

    const result = await save(id, await cookieFor(other, org.id), {
      draft: '{"labels":["negative"]}',
    });
    expect(statusOf(result)).toBe(404);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).draft).toBeNull();
  });

  it('refuses a save that another site made the browser send', async () => {
    const { id, cookie } = await claimed();
    const from = (headers: Record<string, string>) =>
      run(
        draftAction,
        makeRequest(`/work/${id}/draft`, {
          cookie,
          headers,
          form: { draft: '{"labels":["negative"]}' },
        }),
        { assignmentId: id },
      );

    expect(statusOf(await from({ Origin: 'https://elsewhere.example' }))).toBe(403);
    expect(statusOf(await from({ Referer: 'https://elsewhere.example/page' }))).toBe(403);
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id } })).draft).toBeNull();

    expect(statusOf(await from({ Origin: 'http://localhost' }))).toBe(200);
  });

  it('refuses a draft once the claim is no longer active', async () => {
    const { id, ann, cookie } = await claimed();
    await releaseAssignment(id, ann.id);
    const released = await save(id, cookie, { draft: '{"labels":["negative"]}' });
    expect(statusOf(released)).toBe(409);
    expect(await (released as Response).json()).toEqual({ ok: false, error: 'not_active' });

    // past the time limit, even before anyone released the claim
    const late = await claimed(40);
    const expired = await save(late.id, late.cookie, { draft: '{"labels":["negative"]}' });
    expect(statusOf(expired)).toBe(409);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: late.id } });
    expect(row.draft).toBeNull();
  });
});

describe('a manager releasing a claim', () => {
  beforeEach(resetDb);

  async function claimed() {
    const base = await setup();
    const claimedAt = new Date(Date.now() - 20 * 60_000);
    const claim = await claimNextTask(base.project, base.ann.id, claimedAt);
    if (!claim.ok) throw new Error('no claim');
    const saved = await saveDraft(
      claim.assignment.id,
      base.ann.id,
      { draft: { labels: ['positive'] }, activeSeconds: 12 * 60 },
      new Date(claimedAt.getTime() + 15 * 60_000),
    );
    expect(saved.ok).toBe(true);
    const pm = await createMember(base.org.id, 'PROJECT_MANAGER', { name: 'Pat' });
    const taskId = claim.assignment.taskId;
    const release = async (cookie: string) =>
      run(
        taskAction,
        makeRequest(`/projects/${base.project.id}/tasks/${taskId}`, {
          cookie,
          form: { intent: 'release-claim', assignmentId: claim.assignment.id },
        }),
        { projectId: base.project.id, taskId },
      );
    return { ...base, claim: claim.assignment, pm, release };
  }

  it('puts the task back in the queue, drops the draft and records who did it', async () => {
    const { org, project, ann, claim, pm, release } = await claimed();
    const result = await release(await cookieFor(pm, org.id));
    expect(statusOf(result)).toBe(302);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row).toMatchObject({ status: 'RELEASED', draft: null, draftSeconds: 0 });
    // a per-task project pays accepted tasks only, so no time is credited
    expect(row).toMatchObject({ activeSeconds: 0, payableAt: null });
    const entry = await prisma.activity.findFirstOrThrow({
      where: { action: 'assignment.released' },
    });
    expect(entry).toMatchObject({ actorId: pm.id, projectId: project.id });
    expect(entry.detail).toMatchObject({ taskId: claim.taskId, userId: ann.id, seconds: 0 });

    const other = await createMember(org.id, 'ANNOTATOR');
    const next = await claimNextTask(project, other.id);
    expect(next.ok && next.assignment.taskId).toBe(claim.taskId);
  });

  it('is for managers: a reviewer may not release a claim', async () => {
    const { org, project, claim, release } = await claimed();
    const reviewer = await createMember(org.id, 'REVIEWER');
    await addToProject(project.id, reviewer);
    expect(statusOf(await release(await cookieFor(reviewer, org.id)))).toBe(403);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('leaves a claim alone that was submitted in the meantime', async () => {
    const { org, ann, claim, pm, release } = await claimed();
    const submitted = await submitAssignment(claim.id, ann.id, {
      answer: { labels: ['negative'] },
      activeSeconds: 60,
      reviewRequired: true,
    });
    expect(submitted.ok).toBe(true);
    expect(statusOf(await release(await cookieFor(pm, org.id)))).toBe(409);
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row).toMatchObject({ status: 'SUBMITTED', answer: { labels: ['negative'] } });
    expect(await prisma.activity.count({ where: { action: 'assignment.released' } })).toBe(0);
  });

  it('refuses the annotator’s submission and draft save after the release', async () => {
    const { org, ann, claim, pm, cookie, release } = await claimed();
    await release(await cookieFor(pm, org.id));
    const submit = await run(
      workAction,
      makeRequest(`/work/${claim.id}`, {
        cookie,
        form: { answer: JSON.stringify({ labels: ['positive'] }), activeSeconds: '60' },
      }),
      { assignmentId: claim.id },
    );
    expect(statusOf(submit)).toBe(409);
    expect(payload<{ error: string }>(submit).error).toBe('This task is no longer yours.');
    expect(await saveDraft(claim.id, ann.id, { activeSeconds: 60 })).toEqual({
      ok: false,
      error: 'not_active',
    });
  });

  it('credits the time the draft saves recorded on an hourly project, as pay but not as a task', async () => {
    const { org, project, ann, claim, pm } = await claimed();
    const hourly = await prisma.project.update({
      where: { id: project.id },
      data: { payMode: 'HOURLY', rateCents: 1800 },
    });
    const now = new Date();
    const result = await releaseClaim(hourly, claim.id, pm.id, now);
    expect(result).toEqual({ ok: true, creditedSeconds: 12 * 60 });
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row).toMatchObject({ activeSeconds: 720, payMode: 'HOURLY', rateCents: 1800 });
    // the minutes are on the person's clock, so no other work of theirs gets them again
    expect(await prisma.creditedInterval.count({ where: { userId: ann.id } })).toBe(1);
    const day = now.toISOString().slice(0, 10);
    const report = await payoutReport(org.id, { from: day, to: day });
    expect(report.lines).toHaveLength(1);
    expect(report.lines[0]).toMatchObject({ tasks: 0, seconds: 720, amountCents: 360 });
  });

  it('only releases claims of the project it is asked in', async () => {
    const { org, claim, pm } = await claimed();
    const elsewhere = await createTestProject(org.id, { name: 'Other' });
    expect(await releaseClaim(elsewhere, claim.id, pm.id)).toEqual({
      ok: false,
      error: 'not_found',
    });
  });
});

describe('the daily task limit', () => {
  beforeEach(resetDb);

  async function limited(limit: number) {
    const org = await createOrg();
    const base = await createTestProject(org.id, { reviewRequired: false });
    const project = await prisma.project.update({
      where: { id: base.id },
      data: { dailyTaskLimit: limit },
    });
    await createTasks(project.id, [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await addToProject(project.id, ann);
    return { org, project, ann };
  }

  async function submitAt(project: { id: string }, userId: string, at: Date) {
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const claim = await claimNextTask(fresh, userId, at);
    if (!claim.ok) return claim;
    const done = await submitAssignment(
      claim.assignment.id,
      userId,
      { answer: { labels: ['positive'] }, activeSeconds: 30, reviewRequired: false },
      new Date(at.getTime() + 60_000),
    );
    if (!done.ok) throw new Error(done.error);
    return claim;
  }

  it('refuses a claim once the day’s submissions reach the limit, and counts skips out', async () => {
    const { project, ann } = await limited(2);
    const morning = new Date('2026-03-02T08:00:00Z');
    const first = await claimNextTask(project, ann.id, morning);
    if (!first.ok) throw new Error('no claim');
    // a skip earns nothing and does not count
    await skipAssignment(first.assignment.id, ann.id, 'Other: unreadable');
    expect((await submitAt(project, ann.id, new Date('2026-03-02T09:00:00Z'))).ok).toBe(true);
    expect((await submitAt(project, ann.id, new Date('2026-03-02T10:00:00Z'))).ok).toBe(true);
    expect(await claimNextTask(project, ann.id, new Date('2026-03-02T11:00:00Z'))).toEqual({
      ok: false,
      reason: 'limit',
    });
  });

  it('starts again at midnight UTC', async () => {
    const { project, ann } = await limited(1);
    expect((await submitAt(project, ann.id, new Date('2026-03-02T23:50:00Z'))).ok).toBe(true);
    expect(await claimNextTask(project, ann.id, new Date('2026-03-02T23:59:00Z'))).toEqual({
      ok: false,
      reason: 'limit',
    });
    const next = await claimNextTask(project, ann.id, new Date('2026-03-03T00:00:00Z'));
    expect(next.ok).toBe(true);
  });

  it('counts a claim that is still held, and still gives it back on a reload', async () => {
    const { project, ann } = await limited(1);
    const at = new Date(Date.now() - 60_000);
    const first = await claimNextTask(project, ann.id, at);
    expect(first.ok).toBe(true);
    // the claim is the one task of the day: it is resumed, not refused
    expect(await claimNextTask(project, ann.id, at)).toMatchObject({ ok: true, resumed: true });
  });

  it('gives two tabs claiming at the same moment one claim between them', async () => {
    const { project, ann } = await limited(1);
    const at = new Date(Date.now() - 60_000);
    const results = await Promise.all([
      claimNextTask(project, ann.id, at),
      claimNextTask(project, ann.id, at),
      claimNextTask(project, ann.id, at),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.assignment.id : '')));
    expect(ids.size).toBe(1);
    expect(await prisma.assignment.count({ where: { userId: ann.id } })).toBe(1);
  });

  it('makes the dashboard count agree with the claim', async () => {
    const { project, ann } = await limited(1);
    const evening = new Date('2026-03-02T20:00:00Z');
    expect((await countAvailable([project.id], ann.id, evening)).get(project.id)).toBe(4);
    await submitAt(project, ann.id, evening);
    const later = new Date('2026-03-02T21:00:00Z');
    expect((await countAvailable([project.id], ann.id, later)).get(project.id)).toBe(0);
    expect(await claimNextTask(project, ann.id, later)).toMatchObject({ reason: 'limit' });
    const tomorrow = new Date('2026-03-03T00:30:00Z');
    expect((await countAvailable([project.id], ann.id, tomorrow)).get(project.id)).toBe(3);
  });

  it('sends the annotator to the project page with a message that says when the day turns', async () => {
    const { org, project, ann } = await limited(1);
    await submitAt(project, ann.id, new Date(Date.now() - 5 * 60_000));
    const cookie = await cookieFor(ann, org.id);
    const result = await run(
      claimAction,
      makeRequest(`/projects/${project.id}/work`, { cookie, form: {} }),
      { projectId: project.id },
    );
    expect(locationOf(result)).toBe(`/projects/${project.id}?queue=limit`);
  });
});
