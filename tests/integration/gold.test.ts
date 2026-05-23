import { beforeEach, describe, expect, it } from 'vitest';

import { claimNextTask } from '~/models/queue.server';

import { createMember, createOrg, createTestProject, prisma, resetDb, submitWork } from './helpers';

async function setup() {
  const org = await createOrg();
  const project = await createTestProject(org.id, { overlap: 1 });
  const batch = await prisma.batch.create({
    data: { projectId: project.id, name: 'b', format: 'CSV' },
  });
  const gold = await prisma.task.create({
    data: {
      projectId: project.id,
      batchId: batch.id,
      position: 1,
      data: { text: 'I love it' },
      isGold: true,
      goldAnswer: { labels: ['positive'] },
    },
  });
  await prisma.task.create({
    data: { projectId: project.id, batchId: batch.id, position: 2, data: { text: 'regular' } },
  });
  return { org, project, gold };
}

describe('gold accuracy in quality stats', () => {
  beforeEach(resetDb);

  it('averages gold scores per annotator', async () => {
    const { org, project } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    await submitWork(project, ann.id, { labels: ['negative'] });
    const { projectQuality } = await import('~/models/quality.server');
    const quality = await projectQuality(project);
    expect(quality.annotators[0]).toMatchObject({
      goldAttempts: 1,
      goldAccuracy: 0,
      flagged: false,
    });
  });
});

describe('gold tasks', () => {
  beforeEach(resetDb);

  it('scores gold submissions without sending them to review', async () => {
    const { org, project, gold } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');

    const right = await submitWork(project, ann.id, { labels: ['positive'] });
    expect(right).toMatchObject({ taskId: gold.id, goldScore: 1, reviewStatus: 'NOT_REQUIRED' });

    const other = await createMember(org.id, 'ANNOTATOR');
    const wrong = await submitWork(project, other.id, { labels: ['negative'] });
    expect(wrong).toMatchObject({ taskId: gold.id, goldScore: 0 });
  });

  it('shows a gold task to every annotator regardless of overlap and never completes it', async () => {
    const { org, project, gold } = await setup();
    for (let i = 0; i < 3; i++) {
      const user = await createMember(org.id, 'ANNOTATOR');
      await submitWork(project, user.id, { labels: ['positive'] });
    }
    expect(await prisma.assignment.count({ where: { taskId: gold.id } })).toBe(3);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: gold.id } })).status).toBe('OPEN');
  });

  it('does not offer the same gold task twice to one person', async () => {
    const { org, project, gold } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] });
    const next = await claimNextTask(project, ann.id);
    expect(next.ok && next.assignment.taskId).not.toBe(gold.id);
  });
});

describe('my stats', () => {
  beforeEach(resetDb);

  it('summarises an annotator’s last 30 days', async () => {
    const { org, project } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] }, { activeSeconds: 1800 });
    await submitWork(project, ann.id, { labels: ['negative'] }, { activeSeconds: 1800 });
    const { myStats } = await import('~/models/annotator-stats.server');
    const stats = await myStats(ann.id);
    expect(stats).toMatchObject({ submitted: 2, accepted: 1, goldAccuracy: 1, acceptanceRate: 1 });
  });
});
