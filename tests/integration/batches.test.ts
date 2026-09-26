import { beforeEach, describe, expect, it } from 'vitest';

import { action as importAction } from '~/routes/batch-new';
import { action as batchAction, loader as batchLoader } from '~/routes/batch-detail';
import { loader as batchesLoader } from '~/routes/project-batches';

import {
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
  const pm = await createMember(org.id, 'PROJECT_MANAGER');
  const project = await createTestProject(org.id);
  const cookie = await cookieFor(pm, org.id);
  return { org, pm, project, cookie };
}

function upload(name: string, text: string) {
  return new File([text], name, { type: 'text/plain' });
}

describe('batch import', () => {
  beforeEach(resetDb);

  it('imports a csv file as a batch of tasks', async () => {
    const { project, cookie } = await setup();
    const file = upload('reviews.csv', 'id,text\na,good\nb,bad\nc,"fine, I guess"\n');

    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file, name: '' } }),
      { projectId: project.id },
    );

    const batch = await prisma.batch.findFirstOrThrow();
    expect(locationOf(result)).toBe(`/projects/${project.id}/batches/${batch.id}`);
    expect(batch).toMatchObject({ name: 'reviews', format: 'CSV' });
    const tasks = await prisma.task.findMany({ orderBy: { position: 'asc' } });
    expect(tasks.map((t) => [t.position, t.externalId])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(tasks[2].data).toEqual({ id: 'c', text: 'fine, I guess' });
  });

  it('keeps quotes that appear inside quoted csv fields', async () => {
    const { project, cookie } = await setup();
    const file = upload('quotes.csv', 'id,text\nq1,"The ""premium"" model broke"\n');
    await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file } }),
      { projectId: project.id },
    );
    const task = await prisma.task.findFirstOrThrow();
    expect(task.data).toEqual({ id: 'q1', text: 'The "premium" model broke' });
  });

  it('continues positions across batches', async () => {
    const { project, cookie } = await setup();
    const path = `/projects/${project.id}/batches/new`;
    await run(
      importAction,
      makeRequest(path, {
        cookie,
        form: { file: upload('a.jsonl', '{"text":"1"}\n{"text":"2"}') },
      }),
      {
        projectId: project.id,
      },
    );
    await run(
      importAction,
      makeRequest(path, { cookie, form: { file: upload('b.jsonl', '{"text":"3"}') } }),
      {
        projectId: project.id,
      },
    );

    const positions = (await prisma.task.findMany({ orderBy: { position: 'asc' } })).map(
      (t) => t.position,
    );
    expect(positions).toEqual([1, 2, 3]);
  });

  it('rejects a file with invalid rows unless asked to skip them', async () => {
    const { project, cookie } = await setup();
    const path = `/projects/${project.id}/batches/new`;
    const text = 'id,text\n1,ok\n2,\n';

    const rejected = await run(
      importAction,
      makeRequest(path, { cookie, form: { file: upload('t.csv', text) } }),
      {
        projectId: project.id,
      },
    );
    expect(statusOf(rejected)).toBe(400);
    expect(payload<{ errors: unknown[]; validRows: number }>(rejected)).toMatchObject({
      errors: [{ line: 3, message: 'Missing text' }],
      validRows: 1,
    });
    expect(await prisma.task.count()).toBe(0);

    await run(
      importAction,
      makeRequest(path, { cookie, form: { file: upload('t.csv', text), skipInvalid: 'on' } }),
      { projectId: project.id },
    );
    expect(await prisma.task.count()).toBe(1);
  });

  it('deletes an untouched batch but not one with work on it', async () => {
    const { org, project, cookie } = await setup();
    const file = upload('d.csv', 'id,text\n1,a\n2,b\n');
    await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file } }),
      {
        projectId: project.id,
      },
    );
    const batch = await prisma.batch.findFirstOrThrow();
    const path = `/projects/${project.id}/batches/${batch.id}`;

    const ann = await createMember(org.id, 'ANNOTATOR');
    const { claimNextTask, skipAssignment } = await import('~/models/queue.server');
    const claim = await claimNextTask(project, ann.id);
    if (claim.ok) await skipAssignment(claim.assignment.id, ann.id, 'Other: test');

    const refused = await run(
      batchAction,
      makeRequest(path, { cookie, form: { intent: 'delete' } }),
      {
        projectId: project.id,
        batchId: batch.id,
      },
    );
    expect(statusOf(refused)).toBe(409);

    await prisma.assignment.deleteMany();
    const deleted = await run(
      batchAction,
      makeRequest(path, { cookie, form: { intent: 'delete' } }),
      {
        projectId: project.id,
        batchId: batch.id,
      },
    );
    expect(locationOf(deleted)).toBe(`/projects/${project.id}/batches`);
    expect(await prisma.task.count()).toBe(0);
  });

  it('refuses binary files such as spreadsheets', async () => {
    const { project, cookie } = await setup();
    const xlsx = new File(
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe])],
      'tasks.xlsx',
    );
    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file: xlsx } }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(400);
    expect(payload<{ error: string }>(result).error).toMatch(/Export spreadsheets as CSV/);
  });

  it('requires a file', async () => {
    const { project, cookie } = await setup();
    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { name: 'x' } }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(400);
  });

  it('is not available to annotators', async () => {
    const { org, project } = await setup();
    const annotator = await createMember(org.id, 'ANNOTATOR');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: annotator.id } });
    const cookie = await cookieFor(annotator, org.id);

    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: upload('t.csv', 'text\nx\n') },
      }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(403);
  });

  it('searches by external id and text', async () => {
    const { project, cookie } = await setup();
    const file = upload('s.csv', 'id,text\nA-17,battery died\nB-02,great screen\n');
    await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file } }),
      {
        projectId: project.id,
      },
    );
    const batch = await prisma.batch.findFirstOrThrow();
    const search = async (q: string) =>
      payload<{ tasks: Array<{ externalId: string }> }>(
        await run(
          batchLoader,
          makeRequest(`/projects/${project.id}/batches/${batch.id}?q=${encodeURIComponent(q)}`, {
            cookie,
          }),
          { projectId: project.id, batchId: batch.id },
        ),
      ).tasks.map((t) => t.externalId);

    expect(await search('a-17')).toEqual(['A-17']);
    expect(await search('screen')).toEqual(['B-02']);
    expect(await search('nothing')).toEqual([]);
  });

  it('shows the tasks on a partial last page', async () => {
    const { project, cookie } = await setup();
    const rows = Array.from({ length: 30 }, (_, i) => `t${i + 1},text ${i + 1}`).join('\n');
    await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: upload('thirty.csv', `id,text\n${rows}\n`) },
      }),
      { projectId: project.id },
    );
    const batch = await prisma.batch.findFirstOrThrow();

    const page2 = await run(
      batchLoader,
      makeRequest(`/projects/${project.id}/batches/${batch.id}?page=2`, { cookie }),
      { projectId: project.id, batchId: batch.id },
    );
    const data = payload<{ tasks: Array<{ externalId: string }>; page: { pageCount: number } }>(
      page2,
    );
    expect(data.page.pageCount).toBe(2);
    expect(data.tasks.map((t) => t.externalId)).toEqual(['t26', 't27', 't28', 't29', 't30']);
  });

  it('lists batches with their progress and pages through tasks', async () => {
    const { project, cookie } = await setup();
    const rows = Array.from({ length: 50 }, (_, i) => `t${i + 1},text ${i + 1}`).join('\n');
    await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: upload('big.csv', `id,text\n${rows}\n`) },
      }),
      { projectId: project.id },
    );
    const batch = await prisma.batch.findFirstOrThrow();

    const list = await run(
      batchesLoader,
      makeRequest(`/projects/${project.id}/batches`, { cookie }),
      {
        projectId: project.id,
      },
    );
    expect(
      payload<{ batches: Array<{ total: number; complete: number }> }>(list).batches[0],
    ).toMatchObject({
      total: 50,
      complete: 0,
    });

    const page2 = await run(
      batchLoader,
      makeRequest(`/projects/${project.id}/batches/${batch.id}?page=2`, { cookie }),
      { projectId: project.id, batchId: batch.id },
    );
    const tasks = payload<{ tasks: Array<{ externalId: string }> }>(page2).tasks;
    expect(tasks[0].externalId).toBe('t26');
    expect(tasks).toHaveLength(25);
  });
});
