import { beforeEach, describe, expect, it } from 'vitest';

import {
  claimNextTask,
  countAvailable,
  pickNextTask,
  queueSecretFor,
  releaseAssignment,
  skipAssignment,
  submitAssignment,
} from '~/models/queue.server';
import { action as batchAction, loader as batchLoader } from '~/routes/batch-detail';
import { loader as workLoader } from '~/routes/work';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
} from './helpers';

const rows = (n: number, prefix = 'item') =>
  Array.from({ length: n }, (_, i) => ({ text: `${prefix} ${i}` }));

async function annotators(orgId: string, projectId: string, n: number) {
  const users = [];
  for (let i = 0; i < n; i++) users.push(await createMember(orgId, 'ANNOTATOR'));
  await addToProject(projectId, ...users);
  return users;
}

async function reload(projectId: string) {
  return prisma.project.findUniqueOrThrow({ where: { id: projectId } });
}

async function makeGold(taskIds: string[]) {
  await prisma.task.updateMany({
    where: { id: { in: taskIds } },
    data: { isGold: true, goldAnswer: { labels: ['positive'] } },
  });
}

/** Claims and submits one task at `at`, and returns the task it was. */
async function work(projectId: string, userId: string, at: Date) {
  const project = await reload(projectId);
  const claim = await claimNextTask(project, userId, at);
  if (!claim.ok) return null;
  const done = await submitAssignment(
    claim.assignment.id,
    userId,
    { answer: { labels: ['positive'] }, activeSeconds: 5, reviewRequired: false },
    new Date(at.getTime() + 10_000),
  );
  if (!done.ok) throw new Error(done.error);
  return prisma.task.findUniqueOrThrow({ where: { id: claim.assignment.taskId } });
}

/** The order an annotator walks a project in, found by skipping every task. */
async function walk(projectId: string, userId: string) {
  const order: string[] = [];
  const project = await reload(projectId);
  for (;;) {
    const claim = await claimNextTask(project, userId);
    if (!claim.ok) return order;
    order.push(claim.assignment.taskId);
    await skipAssignment(claim.assignment.id, userId, 'Other: walking the queue');
  }
}

describe('queue order', () => {
  beforeEach(resetDb);

  it('keeps position order with the default settings', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    const first = await createTasks(project.id, rows(3, 'first'));
    const second = await createTasks(project.id, rows(3, 'second'));
    const [ann] = await annotators(org.id, project.id, 1);
    expect(await walk(project.id, ann.id)).toEqual([...first, ...second].map((t) => t.id));
  });

  it('serves a higher priority batch first, and a change counts from the next claim', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    const early = await createTasks(project.id, rows(3, 'early'));
    const urgent = await createTasks(project.id, rows(3, 'urgent'));
    const [ann, ben] = await annotators(org.id, project.id, 2);

    const held = await claimNextTask(project, ann.id);
    expect(held.ok && held.assignment.taskId).toBe(early[0].id);

    await prisma.batch.update({ where: { id: urgent[0].batchId }, data: { priority: 5 } });
    const next = await claimNextTask(project, ben.id);
    expect(next.ok && next.assignment.taskId).toBe(urgent[0].id);
    // the claim that existed keeps its task
    const again = await claimNextTask(project, ann.id);
    expect(again.ok && again.resumed && again.assignment.taskId).toBe(early[0].id);
  });

  it('skips a paused batch in the claim and the count, and resumes where it was', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    const held = await createTasks(project.id, rows(2, 'held'));
    const other = await createTasks(project.id, rows(1, 'other'));
    const [ann, ben, cy] = await annotators(org.id, project.id, 3);

    // ann answers the first task (one of two slots); ben is working on it
    await work(project.id, ann.id, new Date(Date.now() - 60_000));
    const working = await claimNextTask(project, ben.id);
    expect(working.ok && working.assignment.taskId).toBe(held[0].id);

    await prisma.batch.update({ where: { id: held[0].batchId }, data: { pausedAt: new Date() } });
    expect((await countAvailable([project.id], cy.id)).get(project.id)).toBe(1);
    const instead = await claimNextTask(project, cy.id);
    expect(instead.ok && instead.assignment.taskId).toBe(other[0].id);
    await skipAssignment(instead.ok ? instead.assignment.id : '', cy.id, 'Other: test');
    expect(await claimNextTask(project, cy.id)).toEqual({ ok: false, reason: 'empty' });

    // the claim that was taken before the pause can still be finished
    const finished = await submitAssignment(working.ok ? working.assignment.id : '', ben.id, {
      answer: { labels: ['positive'] },
      activeSeconds: 1,
      reviewRequired: false,
    });
    expect(finished.ok).toBe(true);

    await prisma.batch.update({ where: { id: held[0].batchId }, data: { pausedAt: null } });
    const resumed = await claimNextTask(project, cy.id);
    expect(resumed.ok && resumed.assignment.taskId).toBe(held[1].id);
  });

  it('gives a task with a partial overlap its remaining slots after a resume', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    const [task] = await createTasks(project.id, rows(1));
    const [ann, ben] = await annotators(org.id, project.id, 2);
    await work(project.id, ann.id, new Date(Date.now() - 60_000));
    await prisma.batch.update({ where: { id: task.batchId }, data: { pausedAt: new Date() } });
    expect(await claimNextTask(project, ben.id)).toEqual({ ok: false, reason: 'empty' });
    await prisma.batch.update({ where: { id: task.batchId }, data: { pausedAt: null } });
    const claim = await claimNextTask(project, ben.id);
    expect(claim.ok && claim.assignment.taskId).toBe(task.id);
  });

  it('shuffles stably for one annotator and differently between two', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    await prisma.project.update({ where: { id: project.id }, data: { queueOrder: 'SHUFFLED' } });
    const tasks = await createTasks(project.id, rows(20));
    const [ann, ben] = await annotators(org.id, project.id, 2);
    const shuffled = await reload(project.id);

    // the same question twice, a reload, gets the same answer
    const picks = [];
    for (let i = 0; i < 2; i++) {
      picks.push(
        await prisma.$transaction(async (tx) =>
          pickNextTask(tx, {
            project: shuffled,
            userId: ann.id,
            now: new Date(),
            secret: await queueSecretFor(tx, project.id),
          }),
        ),
      );
    }
    expect(picks[0]).toBe(picks[1]);
    const claim = await claimNextTask(shuffled, ann.id);
    expect(claim.ok && claim.assignment.taskId).toBe(picks[0]);
    await releaseAssignment(claim.ok ? claim.assignment.id : '', ann.id);
    const after = await claimNextTask(shuffled, ann.id);
    expect(after.ok && after.assignment.taskId).toBe(picks[0]);
    await releaseAssignment(after.ok ? after.assignment.id : '', ann.id);

    const annOrder = await walk(project.id, ann.id);
    const benOrder = await walk(project.id, ben.id);
    const ids = tasks.map((t) => t.id);
    expect([...annOrder].sort()).toEqual([...ids].sort());
    expect([...benOrder].sort()).toEqual([...ids].sort());
    expect(annOrder).not.toEqual(benOrder);
    expect(annOrder).not.toEqual(ids);
  });

  it('keeps batch priority above the shuffle', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    await prisma.project.update({ where: { id: project.id }, data: { queueOrder: 'SHUFFLED' } });
    const low = await createTasks(project.id, rows(5, 'low'));
    const high = await createTasks(project.id, rows(5, 'high'));
    await prisma.batch.update({ where: { id: high[0].batchId }, data: { priority: 1 } });
    const [ann] = await annotators(org.id, project.id, 1);
    const order = await walk(project.id, ann.id);
    const highIds = new Set(high.map((t) => t.id));
    expect(order.slice(0, 5).every((id) => highIds.has(id))).toBe(true);
    expect(new Set(order.slice(5))).toEqual(new Set(low.map((t) => t.id)));
  });

  it('never hands the same task beyond its overlap to annotators claiming at once', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    await prisma.project.update({
      where: { id: project.id },
      data: { queueOrder: 'SHUFFLED', goldEvery: 3 },
    });
    const tasks = await createTasks(project.id, rows(4));
    const gold = await createTasks(project.id, rows(2, 'gold'));
    await makeGold(gold.map((t) => t.id));
    const users = await annotators(org.id, project.id, 10);
    const fresh = await reload(project.id);

    const results = await Promise.all(users.map((u) => claimNextTask(fresh, u.id)));

    // nobody has worked yet, so everyone wants a regular task first; the eight
    // regular slots go to eight people and the other two get gold
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    for (const task of tasks) {
      expect(await prisma.assignment.count({ where: { taskId: task.id } })).toBe(2);
    }
    expect(await prisma.assignment.count({ where: { task: { isGold: true } } })).toBe(2);
  });

  it('waits for a regular task that is being claimed instead of handing out gold first', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2 });
    await prisma.project.update({ where: { id: project.id }, data: { goldEvery: 3 } });
    const [regular] = await createTasks(project.id, rows(1));
    const gold = await createTasks(project.id, rows(1, 'gold'));
    await makeGold(gold.map((t) => t.id));
    const [ann] = await annotators(org.id, project.id, 1);
    const spaced = await reload(project.id);

    // another claim holds the only regular task at this moment
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${regular.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    let settled = false;
    const pending = claimNextTask(spaced, ann.id).then((claim) => {
      settled = true;
      return claim;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // a fresh annotator's first task is never gold: the claim waits
    expect(settled).toBe(false);
    release();
    await holder;
    const claim = await pending;
    expect(claim.ok && claim.assignment.taskId).toBe(regular.id);
    expect(await prisma.assignment.count({ where: { taskId: gold[0].id } })).toBe(0);
  });

  it('passes over a task another claim has locked instead of waiting for it', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    const tasks = await createTasks(project.id, rows(2));
    const [ann] = await annotators(org.id, project.id, 1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Task" WHERE id = ${tasks[0].id} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const claim = await Promise.race([
      claimNextTask(project, ann.id),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
    ]);
    release();
    await holder;
    expect(claim !== 'blocked' && claim.ok && claim.assignment.taskId).toBe(tasks[1].id);
  });
});

describe('gold spacing', () => {
  beforeEach(resetDb);

  async function spaced(goldEvery: number, regular: number, gold: number) {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewRequired: false });
    // gold first in the file: without spacing it would all come at the start
    const goldTasks = await createTasks(project.id, rows(gold, 'gold'));
    await makeGold(goldTasks.map((t) => t.id));
    const regularTasks = await createTasks(project.id, rows(regular, 'regular'));
    await prisma.project.update({ where: { id: project.id }, data: { goldEvery } });
    return { org, project, goldTasks, regularTasks };
  }

  it('serves about one gold task in every N, at uneven intervals, never twice', async () => {
    const goldEvery = 3;
    const { org, project } = await spaced(goldEvery, 90, 40);
    const [ann] = await annotators(org.id, project.id, 1);
    const start = Date.now() - 24 * 3600_000;

    const kinds: boolean[] = [];
    const seen = new Set<string>();
    for (let i = 0; ; i++) {
      const task = await work(project.id, ann.id, new Date(start + i * 60_000));
      if (!task) break;
      expect(seen.has(task.id)).toBe(false);
      seen.add(task.id);
      kinds.push(task.isGold);
    }
    expect(kinds).toHaveLength(130);
    expect(kinds[0]).toBe(false);

    // while both kinds are left, about one in three is gold, and not on a beat
    const both = kinds.slice(0, Math.min(kinds.lastIndexOf(false), kinds.lastIndexOf(true)));
    const share = both.filter(Boolean).length / both.length;
    expect(share).toBeGreaterThan(0.15);
    expect(share).toBeLessThan(0.55);
    const gaps: number[] = [];
    let run = 0;
    for (const gold of both) {
      if (gold) {
        gaps.push(run);
        run = 0;
      } else run++;
    }
    expect(new Set(gaps).size).toBeGreaterThan(2);
    // a gold task can follow a gold task: nothing after one is certain
    expect(gaps).toContain(0);
  });

  it('spaces gold for each annotator on their own', async () => {
    const { org, project } = await spaced(2, 40, 20);
    const [ann, ben] = await annotators(org.id, project.id, 2);
    const start = Date.now() - 24 * 3600_000;
    const kinds = new Map<string, boolean[]>([
      [ann.id, []],
      [ben.id, []],
    ]);
    // the two work at the same time; each gets a sequence of their own
    for (let i = 0; i < 12; i++) {
      for (const user of [ann, ben]) {
        const task = await work(project.id, user.id, new Date(start + i * 60_000));
        kinds.get(user.id)!.push(task!.isGold);
      }
    }
    expect(kinds.get(ann.id)![0]).toBe(false);
    expect(kinds.get(ben.id)![0]).toBe(false);
    expect(kinds.get(ann.id)).not.toEqual(kinds.get(ben.id));
  });

  it('never makes the first task of a session gold, and does not force the second', async () => {
    const { org, project } = await spaced(2, 30, 30);
    const [ann] = await annotators(org.id, project.id, 1);
    const start = Date.now() - 7 * 24 * 3600_000;
    const second: boolean[] = [];
    for (let session = 0; session < 15; session++) {
      const at = start + session * 3 * 3600_000;
      expect((await work(project.id, ann.id, new Date(at)))?.isGold).toBe(false);
      second.push((await work(project.id, ann.id, new Date(at + 60_000)))!.isGold);
    }
    expect(second).toContain(true);
    expect(second).toContain(false);
  });

  it('decides gold timing with the secret, not with anything an annotator sees', async () => {
    const { org, project } = await spaced(2, 10, 10);
    const [ann] = await annotators(org.id, project.id, 1);
    const at = Date.now() - 3600_000;
    // one regular task, so the next claim is a draw (not the first of a session)
    await work(project.id, ann.id, new Date(at));
    const fresh = await reload(project.id);
    // the same annotator, the same ids, the same times: only the secret differs
    const kinds = new Set<boolean>();
    for (let i = 0; i < 20; i++) {
      const picked = await prisma.$transaction((tx) =>
        pickNextTask(tx, {
          project: fresh,
          userId: ann.id,
          now: new Date(at + 60_000),
          secret: `other secret ${i}`,
        }),
      );
      const task = await prisma.task.findUniqueOrThrow({ where: { id: picked! } });
      kinds.add(task.isGold);
    }
    expect(kinds).toEqual(new Set([true, false]));

    // and the secret, like the annotator's id, never reaches the work page
    const secret = await prisma.$transaction((tx) => queueSecretFor(tx, project.id));
    const claim = await claimNextTask(fresh, ann.id, new Date(at + 60_000));
    const id = claim.ok ? claim.assignment.id : '';
    const page = await run(
      workLoader,
      makeRequest(`/work/${id}`, { cookie: await cookieFor(ann, org.id) }),
      { assignmentId: id },
    );
    const text = JSON.stringify(payload(page));
    expect(text).not.toContain(secret);
    expect(text).not.toContain(ann.id);
  });

  it('still serves what is left when only gold or no gold remains', async () => {
    const onlyGold = await spaced(10, 0, 2);
    const [ann] = await annotators(onlyGold.org.id, onlyGold.project.id, 1);
    const first = await work(onlyGold.project.id, ann.id, new Date(Date.now() - 3600_000));
    expect(first?.isGold).toBe(true);

    await resetDb();
    const noGold = await spaced(2, 3, 0);
    const [ben] = await annotators(noGold.org.id, noGold.project.id, 1);
    const start = Date.now() - 3600_000;
    for (let i = 0; i < 3; i++) {
      expect((await work(noGold.project.id, ben.id, new Date(start + i * 60_000)))?.isGold).toBe(
        false,
      );
    }
  });

  it('treats a gold copy like any other gold task and counts retired ones out', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { reviewRequired: false });
    const [original, ...regular] = await createTasks(project.id, rows(8));
    const [copy] = await createTasks(project.id, rows(1, 'copy'));
    await prisma.task.update({
      where: { id: copy.id },
      data: { isGold: true, goldAnswer: { labels: ['positive'] }, goldSourceId: original.id },
    });
    const [retired] = await createTasks(project.id, rows(1, 'retired'));
    await prisma.task.update({
      where: { id: retired.id },
      data: { isGold: true, goldAnswer: { labels: ['positive'] }, goldRetiredAt: new Date() },
    });
    await prisma.project.update({ where: { id: project.id }, data: { goldEvery: 2 } });
    const [ann] = await annotators(org.id, project.id, 1);
    const start = Date.now() - 3600_000;
    const served: string[] = [];
    for (let i = 0; ; i++) {
      const task = await work(project.id, ann.id, new Date(start + i * 60_000));
      if (!task) break;
      served.push(task.id);
    }
    // the copy of the first task is not served to someone who labeled the first
    expect(served).not.toContain(copy.id);
    expect(served).not.toContain(retired.id);
    expect(served).toHaveLength(1 + regular.length);
  });
});

describe('batch queue controls', () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const project = await createTestProject(org.id);
    const tasks = await createTasks(project.id, rows(2));
    const path = `/projects/${project.id}/batches/${tasks[0].batchId}`;
    const params = { projectId: project.id, batchId: tasks[0].batchId };
    return { org, pm, project, tasks, path, params, cookie: await cookieFor(pm, org.id) };
  }

  it('lets a manager set the priority and pause and resume, with activity entries', async () => {
    const { project, path, params, cookie, tasks } = await setup();
    const post = (form: Record<string, string>) =>
      run(batchAction, makeRequest(path, { cookie, form }), params);

    expect(statusOf(await post({ intent: 'priority', priority: '7' }))).toBe(302);
    expect(statusOf(await post({ intent: 'priority', priority: 'soon' }))).toBe(400);
    expect(statusOf(await post({ intent: 'pause' }))).toBe(302);
    expect(statusOf(await post({ intent: 'pause' }))).toBe(409);
    let batch = await prisma.batch.findUniqueOrThrow({ where: { id: tasks[0].batchId } });
    expect(batch.priority).toBe(7);
    expect(batch.pausedAt).not.toBeNull();
    const page = payload<{ batch: { pausedAt: Date | null; priority: number } }>(
      await run(batchLoader, makeRequest(path, { cookie }), params),
    );
    expect(page.batch.priority).toBe(7);

    expect(statusOf(await post({ intent: 'resume' }))).toBe(302);
    batch = await prisma.batch.findUniqueOrThrow({ where: { id: tasks[0].batchId } });
    expect(batch.pausedAt).toBeNull();
    const actions = await prisma.activity.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'batch.priority',
      'batch.paused',
      'batch.resumed',
    ]);
  });

  it('refuses the controls to annotators and reviewers', async () => {
    const { org, project, path, params, tasks } = await setup();
    for (const role of ['ANNOTATOR', 'REVIEWER'] as const) {
      const user = await createMember(org.id, role);
      await addToProject(project.id, user);
      const cookie = await cookieFor(user, org.id);
      const forms: Array<Record<string, string>> = [
        { intent: 'priority', priority: '9' },
        { intent: 'pause' },
      ];
      for (const form of forms) {
        const result = await run(batchAction, makeRequest(path, { cookie, form }), params);
        expect([403, 404]).toContain(statusOf(result));
      }
    }
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: tasks[0].batchId } });
    expect(batch.priority).toBe(0);
    expect(batch.pausedAt).toBeNull();
  });

  it('shows annotators nothing about the batch priority on the work page', async () => {
    const { org, project, tasks } = await setup();
    await prisma.batch.update({ where: { id: tasks[0].batchId }, data: { priority: 42 } });
    const [ann] = await annotators(org.id, project.id, 1);
    const claim = await claimNextTask(project, ann.id);
    const cookie = await cookieFor(ann, org.id);
    const id = claim.ok ? claim.assignment.id : '';
    const page = await run(workLoader, makeRequest(`/work/${id}`, { cookie }), {
      assignmentId: id,
    });
    const text = JSON.stringify(payload(page));
    expect(text).not.toMatch(/priority|pausedAt/);
  });
});
