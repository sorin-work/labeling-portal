import { beforeEach, describe, expect, it } from 'vitest';

import { toCsvExport, toJsonl } from '~/domain/export';
import { parseTaskSchema } from '~/domain/task-schema';
import { adjudicateTask, sendToAdjudication } from '~/models/adjudication.server';
import type { ExportTask } from '~/domain/export';
import { exportTasks } from '~/models/export.server';
import { payoutReport } from '~/models/payouts.server';
import { claimNextTask } from '~/models/queue.server';
import { refreshTaskStatus } from '~/models/tasks.server';
import { loader as adjudicationLoader } from '~/routes/project-adjudication';
import { action as taskAction, loader as taskLoader } from '~/routes/task-detail';

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
  submitWork,
} from './helpers';

const answer = (label: string) => ({ labels: [label] });

async function setup(
  settings: { overlap?: number; threshold?: number | null; maxExtra?: number } = {},
) {
  const org = await createOrg();
  const project = await createTestProject(org.id, {
    overlap: settings.overlap ?? 2,
    reviewRequired: false,
  });
  await prisma.project.update({
    where: { id: project.id },
    data: {
      agreementThreshold: settings.threshold === undefined ? 0.75 : settings.threshold,
      maxExtraAnnotators: settings.maxExtra ?? 1,
    },
  });
  const [task] = await createTasks(project.id, [{ text: 'hard to say' }]);
  const people = [];
  for (let i = 0; i < 5; i++) people.push(await createMember(org.id, 'ANNOTATOR'));
  await addToProject(project.id, ...people);
  const reviewer = await createMember(org.id, 'REVIEWER');
  await addToProject(project.id, reviewer);
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  return { org, project, task, people, reviewer, pm };
}

/** Each person in turn claims the next task and answers it. */
async function label(projectId: string, people: Array<{ id: string }>, labels: string[]) {
  for (const [i, l] of labels.entries())
    await submitWork({ id: projectId }, people[i].id, answer(l));
}

async function loadExport(project: Parameters<typeof exportTasks>[0], scope: 'all' | 'complete') {
  const tasks: ExportTask[] = [];
  for await (const task of exportTasks(project, {
    scope,
    annotators: 'email',
    needs: 'annotations',
  })) {
    tasks.push(task);
  }
  return tasks;
}

const state = (taskId: string) => prisma.task.findUniqueOrThrow({ where: { id: taskId } });

describe('low agreement: extras and adjudication', () => {
  beforeEach(resetDb);

  it('completes a tie without a consensus while the threshold is off, as before', async () => {
    const { project, task, people } = await setup({ threshold: null });
    await label(project.id, people, ['positive', 'negative']);
    const t = await state(task.id);
    expect(t.status).toBe('COMPLETE');
    expect(t.consensus).toBeNull();
    expect(t.extraSlots).toBe(0);
  });

  it('gives a task under the threshold an extra annotator, and the extra answer can settle it', async () => {
    const { project, task, people } = await setup({ threshold: 0.6 });
    await label(project.id, people, ['positive', 'negative']);
    let t = await state(task.id);
    expect(t).toMatchObject({ status: 'OPEN', extraSlots: 1, agreement: 0.5 });

    // the two who answered get nothing more; a third one gets the extra slot
    expect(await claimNextTask(project, people[0].id)).toEqual({ ok: false, reason: 'empty' });
    await submitWork(project, people[2].id, answer('positive'));
    t = await state(task.id);
    expect(t.status).toBe('COMPLETE');
    expect(t.consensus).toEqual(answer('positive'));
    // 2 of 3 is 67%, at or above 60%; nobody else is handed the task
    expect(await claimNextTask(project, people[3].id)).toEqual({ ok: false, reason: 'empty' });
  });

  it('escalates a majority under the threshold, and completes one at the threshold', async () => {
    const under = await setup({ overlap: 3, threshold: 0.8 });
    await label(under.project.id, under.people, ['positive', 'positive', 'negative']);
    expect(await state(under.task.id)).toMatchObject({ status: 'OPEN', extraSlots: 1 });

    await resetDb();
    const at = await setup({ overlap: 3, threshold: 0.67 });
    await label(at.project.id, at.people, ['positive', 'positive', 'negative']);
    expect(await state(at.task.id)).toMatchObject({ status: 'COMPLETE', extraSlots: 0 });
  });

  it('sends a task to adjudication after the last extra, or at once with no extras', async () => {
    const { project, task, people } = await setup({ threshold: 0.75, maxExtra: 1 });
    await label(project.id, people, ['positive', 'negative', 'positive']);
    const t = await state(task.id);
    expect(t.status).toBe('ADJUDICATION');
    expect(t.escalatedAt).not.toBeNull();
    // what the majority says is kept for the adjudicator to choose, and is no result
    expect(t.majority).toEqual(answer('positive'));
    expect(t.consensus).toBeNull();
    expect(await claimNextTask(project, people[3].id)).toEqual({ ok: false, reason: 'empty' });

    await resetDb();
    const none = await setup({ maxExtra: 0 });
    await label(none.project.id, none.people, ['positive', 'negative']);
    expect(await state(none.task.id)).toMatchObject({ status: 'ADJUDICATION', extraSlots: 0 });
  });

  it('adds nothing when the same answers are counted again', async () => {
    const { project, task, people } = await setup({ maxExtra: 3 });
    await label(project.id, people, ['positive', 'negative']);
    for (let i = 0; i < 3; i++) await prisma.$transaction((tx) => refreshTaskStatus(task.id, tx));
    expect(await state(task.id)).toMatchObject({ status: 'OPEN', extraSlots: 1 });
  });

  it('lets a reviewer who did not label it settle the task, with who, when and why', async () => {
    const { org, project, task, people, reviewer } = await setup({ maxExtra: 0 });
    await label(project.id, people, ['positive', 'negative']);
    const path = `/projects/${project.id}/tasks/${task.id}`;
    const params = { projectId: project.id, taskId: task.id };

    // annotators may not; the reason is required; the page offers the answers
    const annCookie = await cookieFor(people[0], org.id);
    const form = {
      intent: 'adjudicate',
      kind: 'own',
      answer: '{"labels":["negative"]}',
      note: 'sarcasm',
    };
    expect(
      statusOf(await run(taskAction, makeRequest(path, { cookie: annCookie, form }), params)),
    ).toBe(403);
    const cookie = await cookieFor(reviewer, org.id);
    expect(
      statusOf(
        await run(taskAction, makeRequest(path, { cookie, form: { ...form, note: ' ' } }), params),
      ),
    ).toBe(400);
    const page = payload<{
      adjudication: { choices: unknown[]; hasConsensus: boolean; refusal: string | null };
    }>(await run(taskLoader, makeRequest(path, { cookie }), params));
    expect(page.adjudication).toMatchObject({ hasConsensus: false, refusal: null });
    expect(page.adjudication.choices).toHaveLength(2);
    const list = payload<{ tasks: Array<{ id: string }> }>(
      await run(
        adjudicationLoader,
        makeRequest(`/projects/${project.id}/adjudication`, { cookie }),
        {
          projectId: project.id,
        },
      ),
    );
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);

    // an answer that the schema refuses is refused
    const bad = await run(
      taskAction,
      makeRequest(path, { cookie, form: { ...form, answer: '{"labels":["maybe"]}' } }),
      params,
    );
    expect(statusOf(bad)).toBe(400);

    expect(statusOf(await run(taskAction, makeRequest(path, { cookie, form }), params))).toBe(302);
    const t = await state(task.id);
    expect(t).toMatchObject({
      status: 'COMPLETE',
      consensus: answer('negative'),
      adjudicatedById: reviewer.id,
      adjudicatedNote: 'sarcasm',
    });
    expect(t.adjudicatedAt).not.toBeNull();
    const logged = await prisma.activity.findFirstOrThrow({
      where: { action: 'task.adjudicated' },
    });
    expect(logged.actorId).toBe(reviewer.id);
  });

  it('refuses someone who labeled the task, and lets only one of two settle it', async () => {
    const { org, project, task, people, reviewer, pm } = await setup({ maxExtra: 0 });
    await addToProject(project.id, pm);
    // a manager can label as well
    await submitWork(project, pm.id, answer('positive'));
    await submitWork(project, people[0].id, answer('negative'));
    expect((await state(task.id)).status).toBe('ADJUDICATION');

    const own = await adjudicateTask(project, task.id, pm.id, { kind: 'consensus' }, 'mine');
    expect(own).toEqual({ ok: false, error: 'own_work' });
    const cookie = await cookieFor(pm, org.id);
    const page = payload<{ adjudication: { refusal: string | null } }>(
      await run(taskLoader, makeRequest(`/projects/${project.id}/tasks/${task.id}`, { cookie }), {
        projectId: project.id,
        taskId: task.id,
      }),
    );
    expect(page.adjudication.refusal).toMatch(/labeled/);

    const second = await createMember(org.id, 'REVIEWER');
    const [submission] = await prisma.assignment.findMany({
      where: { taskId: task.id, userId: people[0].id },
    });
    const results = await Promise.all([
      adjudicateTask(
        project,
        task.id,
        reviewer.id,
        { kind: 'own', answer: answer('positive') },
        'a',
      ),
      adjudicateTask(
        project,
        task.id,
        second.id,
        { kind: 'submission', assignmentId: submission.id },
        'b',
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: 'not_waiting' });
  });

  it('keeps an adjudicated result through later reviews, and the export says where it came from', async () => {
    const { project, task, people, reviewer } = await setup({ maxExtra: 0 });
    const [other] = await createTasks(project.id, [{ text: 'clear' }]);
    await label(project.id, people, ['positive', 'negative']);
    await label(project.id, people.slice(2), ['positive', 'positive']);
    expect((await state(other.id)).status).toBe('COMPLETE');

    const [first] = await prisma.assignment.findMany({
      where: { taskId: task.id, userId: people[0].id },
    });
    await adjudicateTask(
      project,
      task.id,
      reviewer.id,
      { kind: 'submission', assignmentId: first.id },
      'clear',
    );
    await prisma.$transaction((tx) => refreshTaskStatus(task.id, tx));
    expect(await state(task.id)).toMatchObject({
      status: 'COMPLETE',
      consensus: answer('positive'),
    });

    const schema = parseTaskSchema(project.schema);
    if (!schema.ok) throw new Error('schema');
    const lines = toJsonl(schema.schema, await loadExport(project, 'complete'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { task_id: string; consensus_source: string });
    const source = Object.fromEntries(lines.map((l) => [l.task_id, l.consensus_source]));
    expect(source).toEqual({ [task.id]: 'adjudicated', [other.id]: 'majority' });
  });

  it('pays every accepted label once, extras included, and adjudication changes no pay', async () => {
    const { org, project, task, people, reviewer } = await setup({ maxExtra: 1 });
    await label(project.id, people, ['positive', 'negative', 'negative']);
    expect((await state(task.id)).status).toBe('ADJUDICATION');
    const day = new Date().toISOString().slice(0, 10);
    const before = await payoutReport(org.id, { from: '2020-01-01', to: day });
    const text = JSON.stringify(before);
    for (const p of people.slice(0, 3)) expect(text.split(p.id).length - 1).toBe(1);

    await adjudicateTask(project, task.id, reviewer.id, { kind: 'consensus' }, 'majority is right');
    expect(await payoutReport(org.id, { from: '2020-01-01', to: day })).toEqual(before);
    expect(await prisma.assignment.count({ where: { taskId: task.id, status: 'SUBMITTED' } })).toBe(
      3,
    );
  });

  it('does not reopen completed tasks when the settings change later', async () => {
    const { project, task, people } = await setup({ threshold: null });
    await label(project.id, people, ['positive', 'negative']);
    await prisma.project.update({
      where: { id: project.id },
      data: { agreementThreshold: 1, maxExtraAnnotators: 3 },
    });
    await prisma.$transaction((tx) => refreshTaskStatus(task.id, tx));
    expect(await state(task.id)).toMatchObject({ status: 'COMPLETE', extraSlots: 0 });
  });

  it('refuses a reviewer whose fix is one of the answers, and anyone who labeled a gold copy', async () => {
    const { org, project, task, people, reviewer } = await setup({ maxExtra: 0, threshold: 0.75 });
    await prisma.project.update({ where: { id: project.id }, data: { reviewRequired: true } });
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    const first = await submitWork(fresh, people[0].id, answer('positive'));
    await submitWork(fresh, people[1].id, answer('positive'));
    // the reviewer accepts one and turns the other into a different answer
    await prisma.$transaction(async (tx) => {
      await tx.assignment.update({
        where: { id: first.id },
        data: { reviewStatus: 'FIXED', payableAt: new Date() },
      });
      await tx.review.create({
        data: {
          assignmentId: first.id,
          reviewerId: reviewer.id,
          decision: 'FIX',
          correctedAnswer: answer('negative'),
        },
      });
      await tx.assignment.updateMany({
        where: { taskId: task.id, id: { not: first.id } },
        data: { reviewStatus: 'APPROVED', payableAt: new Date() },
      });
      await refreshTaskStatus(task.id, tx);
    });
    expect((await state(task.id)).status).toBe('ADJUDICATION');
    expect(
      await adjudicateTask(
        fresh,
        task.id,
        reviewer.id,
        { kind: 'own', answer: answer('negative') },
        'x',
      ),
    ).toEqual({ ok: false, error: 'own_work' });

    // someone who labeled a gold copy of the same item had a hand in it too
    const [copy] = await createTasks(project.id, [{ text: 'hard to say' }]);
    await prisma.task.update({
      where: { id: copy.id },
      data: { isGold: true, goldAnswer: answer('positive'), goldSourceId: task.id },
    });
    const goldLabeler = await createMember(org.id, 'REVIEWER');
    await prisma.assignment.create({
      data: {
        projectId: project.id,
        taskId: copy.id,
        userId: goldLabeler.id,
        status: 'SUBMITTED',
        expiresAt: new Date(),
        submittedAt: new Date(),
        answer: answer('positive'),
        reviewStatus: 'NOT_REQUIRED',
        payableAt: new Date(),
        rateCents: 0,
        payMode: 'PER_TASK',
      },
    });
    expect(
      await adjudicateTask(fresh, task.id, goldLabeler.id, { kind: 'consensus' }, 'x'),
    ).toEqual({ ok: false, error: 'own_work' });
    const outsider = await createMember(org.id, 'REVIEWER');
    expect(
      await adjudicateTask(
        fresh,
        task.id,
        outsider.id,
        { kind: 'own', answer: answer('positive') },
        'y',
      ),
    ).toEqual({ ok: true });
  });

  it('exports a task in adjudication without a result', async () => {
    const { project, task, people } = await setup({ maxExtra: 0 });
    await label(project.id, people, ['positive', 'negative']);
    const schema = parseTaskSchema(project.schema);
    if (!schema.ok) throw new Error('schema');
    const tasks = await loadExport(project, 'all');
    const [line] = toJsonl(schema.schema, tasks).trim().split('\n');
    expect(JSON.parse(line)).toMatchObject({
      status: 'adjudication',
      consensus: null,
      consensus_source: null,
    });
    const rows = toCsvExport(schema.schema, tasks).trim().split('\r\n').slice(1);
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.startsWith(`${task.id},t1,batch,`) && r.endsWith(',adjudication')),
    ).toBe(true);
    expect(rows.some((r) => r.includes(',consensus,'))).toBe(false);
  });

  it('keeps the majority when a manager sends a waiting task to adjudication', async () => {
    const { project, task, people, reviewer, pm } = await setup({
      overlap: 3,
      threshold: 0.8,
      maxExtra: 2,
    });
    await label(project.id, people, ['positive', 'positive', 'negative']);
    expect(await state(task.id)).toMatchObject({ status: 'OPEN', extraSlots: 1 });
    expect(await sendToAdjudication(project, task.id, pm.id)).toEqual({ ok: true });
    expect(await state(task.id)).toMatchObject({
      status: 'ADJUDICATION',
      majority: answer('positive'),
      consensus: null,
    });
    expect(
      await adjudicateTask(project, task.id, reviewer.id, { kind: 'consensus' }, 'two of three'),
    ).toEqual({ ok: true });
    expect(await state(task.id)).toMatchObject({ consensus: answer('positive'), majority: null });
  });

  it('lets a manager send a task that waits for an extra annotator to adjudication', async () => {
    const { org, project, task, people, reviewer, pm } = await setup({ maxExtra: 2 });
    await label(project.id, people, ['positive', 'negative']);
    const path = `/projects/${project.id}/tasks/${task.id}`;
    const params = { projectId: project.id, taskId: task.id };
    const asReviewer = await cookieFor(reviewer, org.id);
    expect(
      statusOf(
        await run(
          taskAction,
          makeRequest(path, { cookie: asReviewer, form: { intent: 'escalate' } }),
          params,
        ),
      ),
    ).toBe(403);
    const cookie = await cookieFor(pm, org.id);
    expect(
      statusOf(
        await run(taskAction, makeRequest(path, { cookie, form: { intent: 'escalate' } }), params),
      ),
    ).toBe(302);
    expect((await state(task.id)).status).toBe('ADJUDICATION');
    expect(await sendToAdjudication(project, task.id, pm.id)).toEqual({
      ok: false,
      error: 'not_waiting',
    });
  });
});
