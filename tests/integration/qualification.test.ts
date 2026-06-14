import { beforeEach, describe, expect, it } from 'vitest';

import { claimNextTask } from '~/models/queue.server';
import { action as membersAction } from '~/routes/project-members';
import { action as claimAction } from '~/routes/project-work';
import { action as testAction, loader as testLoader } from '~/routes/project-qualification';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTestProject,
  locationOf,
  makeRequest,
  payload,
  prisma,
  resetDb,
  run,
  statusOf,
} from './helpers';

async function setup() {
  const org = await createOrg();
  const project = await prisma.project.update({
    where: { id: (await createTestProject(org.id)).id },
    data: { qualificationRequired: true, qualificationPassPercent: 60 },
  });
  const batch = await prisma.batch.create({
    data: { projectId: project.id, name: 'test', format: 'CSV' },
  });
  const questions = [];
  for (const [i, gold] of ['positive', 'negative', 'positive'].entries()) {
    questions.push(
      await prisma.task.create({
        data: {
          projectId: project.id,
          batchId: batch.id,
          position: i + 1,
          data: { text: `q${i}` },
          isQualification: true,
          goldAnswer: { labels: [gold] },
        },
      }),
    );
  }
  await prisma.task.create({
    data: { projectId: project.id, batchId: batch.id, position: 10, data: { text: 'real work' } },
  });
  const ann = await createMember(org.id, 'ANNOTATOR');
  await addToProject(project.id, ann);
  return { org, project, questions, ann, cookie: await cookieFor(ann, org.id) };
}

function answersFor(questions: Array<{ id: string }>, labels: string[]) {
  return JSON.stringify(
    Object.fromEntries(questions.map((q, i) => [q.id, { labels: [labels[i]] }])),
  );
}

describe('qualification', () => {
  beforeEach(resetDb);

  it('sends unqualified annotators to the test instead of the queue', async () => {
    const { project, cookie } = await setup();
    const result = await run(
      claimAction,
      makeRequest(`/projects/${project.id}/work`, { cookie, form: {} }),
      {
        projectId: project.id,
      },
    );
    expect(locationOf(result)).toBe(`/projects/${project.id}/qualification`);
  });

  it('never hands out test questions as regular work', async () => {
    const { project, ann } = await setup();
    await prisma.projectMember.updateMany({ data: { qualifiedAt: new Date() } });
    const claim = await claimNextTask(project, ann.id);
    const task = claim.ok
      ? await prisma.task.findUniqueOrThrow({ where: { id: claim.assignment.taskId } })
      : null;
    expect(task?.data).toEqual({ text: 'real work' });
  });

  it('does not leak gold answers to the test page', async () => {
    const { project, cookie } = await setup();
    const result = await run(
      testLoader,
      makeRequest(`/projects/${project.id}/qualification`, { cookie }),
      {
        projectId: project.id,
      },
    );
    const tasks = payload<{ tasks: Array<Record<string, unknown>> }>(result).tasks;
    expect(tasks).toHaveLength(3);
    expect(JSON.stringify(tasks)).not.toContain('goldAnswer');
  });

  it('qualifies an annotator who passes', async () => {
    const { project, questions, cookie, ann } = await setup();
    const result = await run(
      testAction,
      makeRequest(`/projects/${project.id}/qualification`, {
        cookie,
        form: { answers: answersFor(questions, ['positive', 'negative', 'positive']) },
      }),
      { projectId: project.id },
    );
    expect(locationOf(result)).toBe(`/projects/${project.id}?queue=qualified`);
    const member = await prisma.projectMember.findFirstOrThrow({ where: { userId: ann.id } });
    expect(member.qualifiedAt).not.toBeNull();
    const attempt = await prisma.qualificationAttempt.findFirstOrThrow();
    expect(attempt).toMatchObject({ scorePercent: 100, passed: true });
  });

  it('passes a perfect score when the pass mark is 100%', async () => {
    const { project, questions, cookie, ann } = await setup();
    await prisma.project.update({
      where: { id: project.id },
      data: { qualificationPassPercent: 100 },
    });
    const result = await run(
      testAction,
      makeRequest(`/projects/${project.id}/qualification`, {
        cookie,
        form: { answers: answersFor(questions, ['positive', 'negative', 'positive']) },
      }),
      { projectId: project.id },
    );
    expect(locationOf(result)).toBe(`/projects/${project.id}?queue=qualified`);
    const member = await prisma.projectMember.findFirstOrThrow({ where: { userId: ann.id } });
    expect(member.qualifiedAt).not.toBeNull();
  });

  it('records a failed attempt and limits retries', async () => {
    const { project, questions, cookie } = await setup();
    const submit = () =>
      run(
        testAction,
        makeRequest(`/projects/${project.id}/qualification`, {
          cookie,
          form: { answers: answersFor(questions, ['negative', 'positive', 'negative']) },
        }),
        { projectId: project.id },
      );
    expect(locationOf(await submit())).toBe(`/projects/${project.id}/qualification?result=failed`);
    await submit();
    await submit();
    const fourth = await submit();
    expect(statusOf(fourth)).toBe(400);
    expect(await prisma.qualificationAttempt.count()).toBe(3);
  });

  it('lets a manager reset the test so the annotator can retake it', async () => {
    const { org, project, questions, cookie, ann } = await setup();
    const wrong = answersFor(questions, ['negative', 'positive', 'negative']);
    for (let i = 0; i < 3; i++) {
      await run(
        testAction,
        makeRequest(`/projects/${project.id}/qualification`, { cookie, form: { answers: wrong } }),
        {
          projectId: project.id,
        },
      );
    }
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    await run(
      membersAction,
      makeRequest(`/projects/${project.id}/members`, {
        cookie: await cookieFor(pm, org.id),
        form: { intent: 'reset-qualification', userId: ann.id },
      }),
      { projectId: project.id },
    );
    expect(await prisma.qualificationAttempt.count()).toBe(0);
  });

  it('requires an answer for every question', async () => {
    const { project, questions, cookie } = await setup();
    const result = await run(
      testAction,
      makeRequest(`/projects/${project.id}/qualification`, {
        cookie,
        form: { answers: JSON.stringify({ [questions[0].id]: { labels: ['positive'] } }) },
      }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(400);
    expect(await prisma.qualificationAttempt.count()).toBe(0);
  });
});
