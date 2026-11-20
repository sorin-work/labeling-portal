import { beforeEach, describe, expect, it } from 'vitest';

import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { action as importAction } from '~/routes/batch-new';
import { loader as downloadLoader } from '~/routes/project-download';
import { action as claimAction } from '~/routes/project-work';
import { loader as qualityLoader } from '~/routes/project-quality';
import { action as workAction, loader as workLoader } from '~/routes/work';

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
  submitWork,
} from './helpers';

const schema = { ...SCHEMA_TEMPLATES.image_classification, labels: ['person', 'car', 'empty'] };

async function world(overlap = 2) {
  const org = await createOrg();
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  const ann = await createMember(org.id, 'ANNOTATOR', { name: 'Ann' });
  const ben = await createMember(org.id, 'ANNOTATOR', { name: 'Ben' });
  const project = await createTestProject(org.id, {
    name: 'Scenes',
    schema,
    overlap,
    reviewRequired: false,
  });
  await addToProject(project.id, ann, ben);
  return { org, pm, ann, ben, project };
}

describe('an image classification project', () => {
  beforeEach(resetDb);

  it('imports, is labeled through the work page, completes and exports', async () => {
    const { org, pm, ann, ben, project } = await world();
    const file = new File(
      [
        [
          'id,image_url,_gold',
          'one,https://cdn.example.test/1.jpg,',
          'two,/demo/street-2.svg,',
        ].join('\n'),
      ],
      'scenes.csv',
      { type: 'text/csv' },
    );
    const imported = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie: await cookieFor(pm, org.id),
        form: { file, name: 'Scenes' },
      }),
      { projectId: project.id },
    );
    expect(locationOf(imported)).toMatch(/\/batches\//);
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(2);

    // an internal address is refused, as for boxes
    const refused = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie: await cookieFor(pm, org.id),
        form: {
          file: new File(['image_url\nhttp://169.254.169.254/x.jpg\n'], 'bad.csv'),
          name: 'Bad',
        },
      }),
      { projectId: project.id },
    );
    expect(JSON.stringify(payload(refused))).toContain('must be a public http(s) URL');

    // both annotators label both images through the routes
    for (const [person, labels] of [
      [ann, [['person'], ['car']]],
      [ben, [['person'], ['empty']]],
    ] as const) {
      const cookie = await cookieFor(person, org.id);
      let at = locationOf(
        await run(claimAction, makeRequest(`/projects/${project.id}/work`, { cookie, form: {} }), {
          projectId: project.id,
        }),
      );
      for (const answer of labels) {
        const id = at!.split('/').pop()!;
        const page = payload<{ task: { data: Record<string, unknown> } }>(
          await run(workLoader, makeRequest(`/work/${id}`, { cookie }), { assignmentId: id }),
        );
        expect(String(page.task.data.image_url)).toMatch(/1\.jpg|street-2\.svg/);
        at = locationOf(
          await run(
            workAction,
            makeRequest(`/work/${id}`, {
              cookie,
              form: { intent: 'submit', answer: JSON.stringify({ labels: answer }) },
            }),
            { assignmentId: id },
          ),
        );
      }
    }

    const tasks = await prisma.task.findMany({ orderBy: { position: 'asc' } });
    expect(tasks.map((t) => t.status)).toEqual(['COMPLETE', expect.any(String)]);
    expect(tasks[0].consensus).toEqual({ labels: ['person'] });

    const download = async (query: string) =>
      (await run(
        downloadLoader,
        makeRequest(`/projects/${project.id}/download?${query}`, {
          cookie: await cookieFor(pm, org.id),
        }),
        { projectId: project.id },
      )) as Response;
    const lines = (await (await download('format=jsonl&scope=all')).text()).trim().split('\n');
    const first = JSON.parse(lines[0]);
    expect(first.data.image_url).toBe('https://cdn.example.test/1.jpg');
    expect(first.consensus).toEqual({ labels: ['person'] });
    expect(first.annotations).toHaveLength(2);
    const csv = await (await download('format=csv&scope=all')).text();
    expect(csv.split('\r\n')[0]).toContain('labels');
    expect(csv).toContain('person');
  });

  it('gets kappa on the quality page, not the F1 of spans and boxes', async () => {
    const { org, pm, ann, ben, project } = await world();
    await createTasks(
      project.id,
      [1, 2, 3, 4].map((n) => ({ image_url: `/demo/street-${n}.svg` })),
    );
    const annLabels = ['person', 'car', 'empty', 'person'];
    const benLabels = ['person', 'car', 'empty', 'car'];
    const start = Date.now() - 60 * 60_000;
    for (let i = 0; i < 4; i++) {
      const now = new Date(start + i * 10 * 60_000);
      await submitWork(project, ann.id, { labels: [annLabels[i]] }, { activeSeconds: 60, now });
      await submitWork(project, ben.id, { labels: [benLabels[i]] }, { activeSeconds: 60, now });
    }
    const quality = payload<{
      agreement: {
        categorical: boolean;
        fleiss: number | null;
        pairs: Array<{ shared: number; kappa: number | null }>;
      };
    }>(
      await run(
        qualityLoader,
        makeRequest(`/projects/${project.id}/quality`, { cookie: await cookieFor(pm, org.id) }),
        { projectId: project.id },
      ),
    );
    expect(quality.agreement.categorical).toBe(true);
    expect(quality.agreement.pairs).toEqual([
      expect.objectContaining({ shared: 4, kappa: expect.any(Number) }),
    ]);
    expect(quality.agreement.pairs[0].kappa).toBeGreaterThan(0.5);
    expect(quality.agreement.fleiss).not.toBeNull();
  });
});
