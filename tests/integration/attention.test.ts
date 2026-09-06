import { beforeEach, describe, expect, it } from 'vitest';

import { needsAttention } from '~/models/attention.server';

import { createMember, createOrg, createTestProject, prisma, resetDb, submitWork } from './helpers';

describe('needs attention', () => {
  beforeEach(resetDb);

  it('lists old pending reviews and annotators failing gold tasks', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { name: 'Sentiment' });
    const batch = await prisma.batch.create({
      data: { projectId: project.id, name: 'b', format: 'CSV' },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.task.create({
        data: {
          projectId: project.id,
          batchId: batch.id,
          position: i + 1,
          data: { text: `gold ${i}` },
          isGold: true,
          goldAnswer: { labels: ['positive'] },
        },
      });
    }
    await prisma.task.create({
      data: { projectId: project.id, batchId: batch.id, position: 9, data: { text: 'x' } },
    });
    const sloppy = await createMember(org.id, 'ANNOTATOR', { name: 'Sloppy' });
    for (let i = 0; i < 3; i++) await submitWork(project, sloppy.id, { labels: ['negative'] });
    await submitWork(
      project,
      sloppy.id,
      { labels: ['negative'] },
      { now: new Date(Date.now() - 3 * 86_400_000) },
    );

    const items = await needsAttention(org.id);
    expect(items).toEqual(
      expect.arrayContaining([
        { kind: 'stale-reviews', projectId: project.id, projectName: 'Sentiment', count: 1 },
        expect.objectContaining({ kind: 'low-gold', userName: 'Sloppy', accuracy: 0, attempts: 3 }),
      ]),
    );
  });

  it('is empty for a quiet organisation', async () => {
    const org = await createOrg();
    await createTestProject(org.id);
    expect(await needsAttention(org.id)).toEqual([]);
  });
});
