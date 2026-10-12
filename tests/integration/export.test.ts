import { beforeEach, describe, expect, it } from 'vitest';

import { loader as downloadLoader } from '~/routes/project-download';

import {
  cookieFor,
  createMember,
  createOrg,
  createTasks,
  createTestProject,
  makeRequest,
  prisma,
  resetDb,
  run,
  statusOf,
  submitWork,
} from './helpers';

describe('label export', () => {
  beforeEach(resetDb);

  async function setup() {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const project = await createTestProject(org.id, { reviewRequired: false });
    await createTasks(project.id, [{ text: 'good' }, { text: 'bad' }, { text: 'later' }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, { labels: ['positive'] });
    await submitWork(project, ann.id, { labels: ['negative'] });
    return { org, project, cookie: await cookieFor(pm, org.id) };
  }

  it('downloads completed tasks as jsonl', async () => {
    const { project, cookie } = await setup();
    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=jsonl`, { cookie }),
      { projectId: project.id },
    )) as Response;
    expect(response.headers.get('Content-Disposition')).toContain('sentiment-complete.jsonl');
    const rows = (await response.text())
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.consensus)).toEqual([
      { labels: ['positive'] },
      { labels: ['negative'] },
    ]);
  });

  it('includes unfinished tasks when asked', async () => {
    const { project, cookie } = await setup();
    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=csv&scope=all`, { cookie }),
      { projectId: project.id },
    )) as Response;
    const text = await response.text();
    expect(text.trimEnd().split('\r\n')).toHaveLength(5);
  });

  it('exports one batch when asked', async () => {
    const { project, cookie } = await setup();
    const extra = await createTasks(project.id, [{ text: 'other batch' }]);
    await prisma.task.update({
      where: { id: extra[0].id },
      data: { status: 'COMPLETE', consensus: { labels: ['neutral'] } },
    });
    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=jsonl&batch=${extra[0].batchId}`, {
        cookie,
      }),
      { projectId: project.id },
    )) as Response;
    const rows = (await response.text())
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.map((r) => r.consensus)).toEqual([{ labels: ['neutral'] }]);
  });

  it('leaves gold tasks out', async () => {
    const { project, cookie } = await setup();
    await prisma.task.updateMany({ where: { position: 1 }, data: { isGold: true } });
    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=jsonl`, { cookie }),
      { projectId: project.id },
    )) as Response;
    expect((await response.text()).trimEnd().split('\n')).toHaveLength(1);
  });

  it('rejects coco for non-box projects and unknown formats', async () => {
    const { project, cookie } = await setup();
    const coco = await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=coco`, { cookie }),
      { projectId: project.id },
    );
    expect(statusOf(coco)).toBe(400);
    const xml = await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=xml`, { cookie }),
      { projectId: project.id },
    );
    expect(statusOf(xml)).toBe(400);
  });

  it('downloads a coco dataset for a box project', async () => {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const project = await createTestProject(org.id, {
      name: 'Streets',
      reviewRequired: false,
      schema: { kind: 'bbox', imageField: 'image_url', labels: ['car', 'person'] },
    });
    await createTasks(project.id, [{ image_url: '/demo/street-1.svg', width: 640, height: 400 }]);
    const ann = await createMember(org.id, 'ANNOTATOR');
    await submitWork(project, ann.id, {
      imageWidth: 640,
      imageHeight: 400,
      boxes: [{ x: 10, y: 20, w: 100, h: 50, label: 'person' }],
    });

    const response = (await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download?format=coco`, {
        cookie: await cookieFor(pm, org.id),
      }),
      { projectId: project.id },
    )) as Response;
    expect(response.headers.get('Content-Disposition')).toContain('streets-complete.coco.json');
    const coco = await response.json();
    expect(coco.categories).toEqual([
      { id: 1, name: 'car' },
      { id: 2, name: 'person' },
    ]);
    expect(coco.annotations).toEqual([
      expect.objectContaining({ image_id: 1, category_id: 2, bbox: [10, 20, 100, 50], area: 5000 }),
    ]);
  });

  it('is not available to reviewers', async () => {
    const { org, project } = await setup();
    const reviewer = await createMember(org.id, 'REVIEWER');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: reviewer.id } });
    const result = await run(
      downloadLoader,
      makeRequest(`/projects/${project.id}/download`, {
        cookie: await cookieFor(reviewer, org.id),
      }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(403);
  });
});
