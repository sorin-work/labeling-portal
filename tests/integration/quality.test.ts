import { beforeEach, describe, expect, it } from 'vitest';

import { recordReview } from '~/models/reviews.server';
import { loader as qualityLoader } from '~/routes/project-quality';

import {
  addToProject,
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  makeRequest,
  payload,
  resetDb,
  run,
  statusOf,
  submitWork,
} from './helpers';

type Quality = {
  annotators: Array<{
    name: string;
    submitted: number;
    approvalRate: number | null;
    avgQaScore: number | null;
    tasksPerHour: number | null;
  }>;
  agreement: { fleiss: number | null; pairs: Array<{ shared: number; kappa: number | null }> };
};

describe('quality stats', () => {
  beforeEach(resetDb);

  it('summarises annotators and their agreement', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, {
      overlap: 2,
      schema: { kind: 'text_classification', textField: 'text', labels: ['a', 'b', 'c'] },
    });
    await createTasks(project.id, [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }]);
    const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
    const ben = await createMember(org.id, 'ANNOTATOR', { name: 'Ben' });
    const reviewer = await createMember(org.id, 'REVIEWER');
    await addToProject(project.id, ann, ben, reviewer);

    const annLabels = ['a', 'b', 'c', 'a'];
    const benLabels = ['a', 'b', 'c', 'b'];
    const annWork = [];
    for (let i = 0; i < 4; i++) {
      annWork.push(
        await submitWork(project, ann.id, { labels: [annLabels[i]] }, { activeSeconds: 60 }),
      );
      await submitWork(project, ben.id, { labels: [benLabels[i]] }, { activeSeconds: 120 });
    }
    await recordReview(annWork[0].id, reviewer.id, {
      decision: 'APPROVE',
      qaScore: 5,
      feedback: '',
    });
    await recordReview(annWork[1].id, reviewer.id, {
      decision: 'SEND_BACK',
      qaScore: 2,
      feedback: 'no',
    });

    const result = await run(
      qualityLoader,
      makeRequest(`/projects/${project.id}/quality`, { cookie: await cookieFor(reviewer, org.id) }),
      { projectId: project.id },
    );
    const quality = payload<Quality>(result);

    expect(quality.annotators.map((a) => a.name)).toEqual(['Ann', 'Ben']);
    expect(quality.annotators[0]).toMatchObject({
      submitted: 4,
      approvalRate: 0.5,
      avgQaScore: 3.5,
      tasksPerHour: 60,
    });
    expect(quality.annotators[1].tasksPerHour).toBe(30);
    expect(quality.agreement.pairs).toHaveLength(1);
    expect(quality.agreement.pairs[0].shared).toBe(4);
    expect(quality.agreement.pairs[0].kappa).toBeCloseTo(0.636, 2);
    expect(quality.agreement.fleiss).not.toBeNull();
  });

  it('reports full agreement for a pair that always chose the same label', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id, { overlap: 2, reviewRequired: false });
    await createTasks(project.id, [{ text: '1' }, { text: '2' }, { text: '3' }]);
    const a = await createMember(org.id, 'ANNOTATOR');
    const b = await createMember(org.id, 'ANNOTATOR');
    for (let i = 0; i < 3; i++) {
      await submitWork(project, a.id, { labels: ['positive'] });
      await submitWork(project, b.id, { labels: ['positive'] });
    }
    const { projectQuality } = await import('~/models/quality.server');
    const quality = await projectQuality(project);
    expect(quality.agreement.pairs[0].kappa).toBe(1);
    expect(quality.agreement.fleiss).toBe(1);
  });

  it('groups skip reasons', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    await createTasks(project.id, [{ text: '1' }, { text: '2' }, { text: '3' }]);
    const { claimNextTask, skipAssignment } = await import('~/models/queue.server');
    for (const reason of [
      'Other: blank page',
      'Other: in French',
      'Content is broken or unreadable',
    ]) {
      const user = await createMember(org.id, 'ANNOTATOR');
      const claim = await claimNextTask(project, user.id);
      if (claim.ok) await skipAssignment(claim.assignment.id, user.id, reason);
    }
    const { projectQuality } = await import('~/models/quality.server');
    const quality = await projectQuality(project);
    expect(quality.skipReasons).toEqual([
      { reason: 'Other', count: 2 },
      { reason: 'Content is broken or unreadable', count: 1 },
    ]);
  });

  it('is not available to annotators', async () => {
    const org = await createOrg();
    const project = await createTestProject(org.id);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await addToProject(project.id, ann);
    const result = await run(
      qualityLoader,
      makeRequest(`/projects/${project.id}/quality`, { cookie: await cookieFor(ann, org.id) }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(403);
  });
});
