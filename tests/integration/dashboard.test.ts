import { beforeEach, describe, expect, it } from 'vitest';

import { loader as dashboardLoader } from '~/routes/dashboard';

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
  submitWork,
} from './helpers';

type Dashboard = {
  canAnnotate: boolean;
  projects: Array<{ name: string; available: number }>;
  stats: { submitted: number } | null;
  attention: unknown[] | null;
  reviewing: { reviews: number } | null;
};

describe('dashboard', () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const project = await createTestProject(org.id, { name: 'Sentiment', overlap: 1 });
    await createTasks(project.id, [{ text: '1' }, { text: '2' }, { text: '3' }]);
    return { org, project };
  }

  it('shows annotators their projects, available tasks and stats', async () => {
    const { org, project } = await setup();
    const ann = await createMember(org.id, 'ANNOTATOR');
    await addToProject(project.id, ann);
    await submitWork(project, ann.id, { labels: ['positive'] });

    const data = payload<Dashboard>(
      await run(dashboardLoader, makeRequest('/', { cookie: await cookieFor(ann, org.id) })),
    );
    expect(data.canAnnotate).toBe(true);
    expect(data.projects).toEqual([expect.objectContaining({ name: 'Sentiment', available: 2 })]);
    expect(data.stats?.submitted).toBe(1);
    expect(data.attention).toBeNull();
  });

  it('shows managers the needs-attention list and no annotator stats', async () => {
    const { org } = await setup();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const data = payload<Dashboard>(
      await run(dashboardLoader, makeRequest('/', { cookie: await cookieFor(pm, org.id) })),
    );
    expect(data.canAnnotate).toBe(false);
    expect(data.stats).toBeNull();
    expect(data.attention).toEqual([]);
  });

  it('shows reviewers their week', async () => {
    const { org, project } = await setup();
    const reviewer = await createMember(org.id, 'REVIEWER');
    await addToProject(project.id, reviewer);
    const data = payload<Dashboard>(
      await run(dashboardLoader, makeRequest('/', { cookie: await cookieFor(reviewer, org.id) })),
    );
    expect(data.reviewing).toEqual({ reviews: 0, sentBack: 0, fixed: 0, avgScore: null });
  });
});
