import { beforeEach, describe, expect, it } from 'vitest';

import { claimNextTask, clampActiveSeconds } from '~/models/queue.server';
import { action as workAction, loader as workLoader } from '~/routes/work';
import { action as claimAction } from '~/routes/project-work';

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
    expect(payload<{ task: { id: string } }>(page).task.id).toBe(tasks[0].id);
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

  it('keeps claims that are still within the limit', async () => {
    const { org, project, ann, tasks } = await setup();
    const t0 = new Date('2026-01-10T09:00:00Z');
    await claimNextTask(project, ann.id, t0);

    const other = await createMember(org.id, 'ANNOTATOR');
    const claim = await claimNextTask(project, other.id, new Date(t0.getTime() + 29 * 60_000));
    expect(claim.ok && claim.assignment.taskId).toBe(tasks[1].id);
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
