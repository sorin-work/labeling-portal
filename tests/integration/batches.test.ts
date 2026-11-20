import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { ZipWriter } from '~/domain/zip';
import { createBatch } from '~/models/batches.server';
import { projectSchema, schemaUsage } from '~/models/projects.server';
import { action as importAction } from '~/routes/batch-new';
import { action as batchAction, loader as batchLoader } from '~/routes/batch-detail';
import { loader as batchesLoader } from '~/routes/project-batches';
import { action as settingsAction } from '~/routes/project-settings';

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

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'import', name));

type Refusal = {
  error: string;
  errors: Array<{ line: number; message: string }>;
  more: number;
  unit: string;
  validRows: number;
};

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

  it('imports a file completely or not at all', async () => {
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
    expect(payload<Refusal>(rejected)).toMatchObject({
      errors: [{ line: 3, message: 'Missing text' }],
      more: 0,
      unit: 'line',
      validRows: 1,
    });
    expect(await prisma.task.count()).toBe(0);

    // there is no way to ask for the good rows only
    const again = await run(
      importAction,
      makeRequest(path, { cookie, form: { file: upload('t.csv', text), skipInvalid: 'on' } }),
      { projectId: project.id },
    );
    expect(statusOf(again)).toBe(400);
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.batch.count()).toBe(0);
  });

  it('lists the first lines that failed and says how many more did', async () => {
    const { project, cookie } = await setup();
    const lines = ['id,text'];
    for (let i = 1; i <= 35; i++) lines.push(`row${i},`);
    lines.push('fine,this one has text');

    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: upload('many.csv', lines.join('\n')) },
      }),
      { projectId: project.id },
    );

    expect(statusOf(result)).toBe(400);
    const refusal = payload<Refusal>(result);
    expect(refusal.errors).toHaveLength(20);
    expect(refusal.errors[0]).toEqual({ line: 2, message: 'Missing text' });
    expect(refusal.errors[19]).toEqual({ line: 21, message: 'Missing text' });
    expect(refusal).toMatchObject({ more: 15, validRows: 1 });
    expect(await prisma.task.count()).toBe(0);
  });

  it('reads tab-separated, semicolon and json array files and records what they were', async () => {
    const { project, cookie } = await setup();
    const path = `/projects/${project.id}/batches/new`;
    for (const name of ['reviews.tsv', 'reviews-semicolon.csv', 'reviews.json', 'reviews.jsonl']) {
      const result = await run(
        importAction,
        makeRequest(path, { cookie, form: { file: new File([fixture(name)], name) } }),
        { projectId: project.id },
      );
      expect(statusOf(result), name).toBe(302);
    }

    const batches = await prisma.batch.findMany({
      orderBy: { createdAt: 'asc' },
      include: { tasks: { orderBy: { position: 'asc' } } },
    });
    expect(batches.map((b) => [b.name, b.format, b.tasks.length])).toEqual([
      ['reviews', 'TSV', 3],
      ['reviews-semicolon', 'CSV', 3],
      ['reviews', 'JSON', 3],
      ['reviews', 'JSONL', 3],
    ]);
    expect(batches[1].tasks[1].data).toEqual({
      id: 'r2',
      text: 'Semicolons; inside quotes',
      price: '3,99',
    });
    // the json array and the json lines file hold the same tasks
    expect(batches[2].tasks.map((t) => t.data)).toEqual(batches[3].tasks.map((t) => t.data));
    expect(batches[2].tasks[1].data).toMatchObject({ meta: { stars: 1, verified: true } });
  });

  it('refuses archives and compressed files without unpacking them', async () => {
    const { project, cookie } = await setup();
    const zip = new ZipWriter();
    const archive = Buffer.concat([zip.add('tasks.csv', 'text\nhello\n'), zip.finish()]);
    for (const file of [
      new File([archive], 'tasks.zip'),
      new File([archive], 'tasks.csv'),
      new File([gzipSync('text\nhello\n')], 'tasks.csv.gz'),
    ]) {
      const result = await run(
        importAction,
        makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file } }),
        { projectId: project.id },
      );
      expect(statusOf(result), file.name).toBe(400);
      expect(payload<Refusal>(result).error).toMatch(/Zip and gzip files are not read/);
    }
    expect(await prisma.task.count()).toBe(0);
  });

  it('stops reading an upload that is larger than the limit', async () => {
    const { project, cookie } = await setup();
    // one valid line, repeated until the file is over 5 MB
    const line = `${'x'.repeat(1000)}\n`;
    const big = upload('big.csv', `text\n${line.repeat(5400)}`);
    expect(big.size).toBeGreaterThan(5 * 1024 * 1024);

    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, { cookie, form: { file: big } }),
      { projectId: project.id },
    );

    expect(statusOf(result)).toBe(413);
    expect(payload<Refusal>(result).error).toBe('Files can be at most 5 MB.');
    expect(await prisma.task.count()).toBe(0);
  });

  it('stores image addresses as text, refuses the unsafe kinds and fetches nothing', async () => {
    const { org, cookie } = await setup();
    const boxes = await createTestProject(org.id, { schema: SCHEMA_TEMPLATES.bbox });
    const path = `/projects/${boxes.id}/batches/new`;
    const fetched = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no requests'));
    try {
      const refused = await run(
        importAction,
        makeRequest(path, {
          cookie,
          form: { file: new File([fixture('images-refused.jsonl')], 'images-refused.jsonl') },
        }),
        { projectId: boxes.id },
      );
      expect(statusOf(refused)).toBe(400);
      expect(payload<Refusal>(refused).errors).toHaveLength(8);
      expect(await prisma.task.count()).toBe(0);

      const imported = await run(
        importAction,
        makeRequest(path, {
          cookie,
          form: { file: new File([fixture('images.csv')], 'images.csv') },
        }),
        { projectId: boxes.id },
      );
      expect(statusOf(imported)).toBe(302);
      const tasks = await prisma.task.findMany({ orderBy: { position: 'asc' } });
      expect(tasks.map((t) => (t.data as { image_url: string }).image_url)).toEqual([
        'http://images.example.test/a.jpg',
        'https://images.example.test/b.jpg',
        '/demo/street-1.svg',
      ]);
      // the server never asked for any of them
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  it('refuses an internal image host unless the installation lists it', async () => {
    const { org, cookie } = await setup();
    const boxes = await createTestProject(org.id, { schema: SCHEMA_TEMPLATES.bbox });
    const upload = () =>
      run(
        importAction,
        makeRequest(`/projects/${boxes.id}/batches/new`, {
          cookie,
          form: {
            file: new File(
              [
                '{"image_url":"http://169.254.169.254/a.jpg"}\n{"image_url":"http://intranet/b.jpg"}\n',
              ],
              'internal.jsonl',
            ),
          },
        }),
        { projectId: boxes.id },
      );
    const before = process.env.INTERNAL_IMAGE_HOSTS;
    try {
      delete process.env.INTERNAL_IMAGE_HOSTS;
      const refused = await upload();
      expect(statusOf(refused)).toBe(400);
      expect(payload<Refusal>(refused).errors.map((e) => e.line)).toEqual([1, 2]);

      process.env.INTERNAL_IMAGE_HOSTS = ' Intranet , 169.254.169.254';
      expect(statusOf(await upload())).toBe(302);
      expect(await prisma.task.count()).toBe(2);
    } finally {
      if (before === undefined) delete process.env.INTERNAL_IMAGE_HOSTS;
      else process.env.INTERNAL_IMAGE_HOSTS = before;
    }
  });

  it('checks gold answers like any answer, and a schema edit counts them', async () => {
    const { org, cookie } = await setup();
    const project = await createTestProject(org.id, {
      schema: SCHEMA_TEMPLATES.text_classification,
    });
    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: new File([fixture('gold.csv')], 'gold.csv') },
      }),
      { projectId: project.id },
    );
    expect(statusOf(result)).toBe(302);
    const tasks = await prisma.task.findMany({ orderBy: { position: 'asc' } });
    expect(tasks.map((t) => [t.externalId, t.isGold, t.goldAnswer])).toEqual([
      ['g1', true, { labels: ['positive'] }],
      ['g2', true, { labels: ['neutral'] }],
      ['t1', false, null],
    ]);

    // the imported label is stored work: the schema cannot drop it now
    const usage = await schemaUsage(project.id);
    expect(usage.names.get('neutral')).toEqual({ gold: 1 });
    const saved = await run(
      settingsAction,
      makeRequest(`/projects/${project.id}/settings`, {
        cookie,
        form: {
          name: project.name,
          description: '',
          instructions: '',
          overlap: '1',
          timeLimitMinutes: '30',
          schema: JSON.stringify({
            ...SCHEMA_TEMPLATES.text_classification,
            labels: ['positive', 'negative'],
          }),
        },
      }),
      { projectId: project.id },
    );
    expect(statusOf(saved)).toBe(400);
    expect(payload<{ errors: { schema: string } }>(saved).errors.schema).toContain(
      'the label “neutral” cannot be removed or renamed while 1 stored answer uses it (1 gold answer)',
    );
  });

  it('refuses a batch whose rows were checked against a schema that has changed since', async () => {
    const { project } = await setup();
    const rows = [
      { line: 2, externalId: 'a', data: { text: 'x' }, gold: { labels: ['negative'] } },
    ];
    const read = projectSchema(project);
    const input = { name: 'b', format: 'CSV' as const, rows, schema: read };

    // a settings save that drops the label is about to commit
    let commit = () => {};
    const waiting = new Promise<void>((resolve) => (commit = resolve));
    let locked = () => {};
    const saveHasTheRow = new Promise<void>((resolve) => (locked = resolve));
    const narrower = { ...read, labels: ['positive', 'other'] };
    const saving = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${project.id} FOR NO KEY UPDATE`;
      await tx.project.update({ where: { id: project.id }, data: { schema: narrower } });
      locked();
      await waiting;
    });
    await saveHasTheRow;

    const importing = createBatch(project.id, input);
    // the import waits for the save instead of writing a label the save removes
    const first = await Promise.race([
      importing.then(() => 'imported'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(first).toBe('waiting');
    commit();
    await saving;

    expect(await importing).toEqual({ ok: false, error: 'schema_changed' });
    expect(await prisma.batch.count()).toBe(0);
    expect(await prisma.task.count()).toBe(0);
    // rows that were read against the schema as it is now go in
    const reread = [{ line: 2, externalId: 'a', data: { text: 'x' }, gold: { labels: ['other'] } }];
    expect(
      await createBatch(project.id, { ...input, rows: reread, schema: narrower }),
    ).toMatchObject({ ok: true });
    expect(await prisma.task.count()).toBe(1);
  });

  it('needs a gold answer on every row of a qualification test', async () => {
    const { project, cookie } = await setup();
    const result = await run(
      importAction,
      makeRequest(`/projects/${project.id}/batches/new`, {
        cookie,
        form: { file: new File([fixture('gold.csv')], 'gold.csv'), qualification: 'on' },
      }),
      { projectId: project.id },
    );
    // the fixture's labels need a schema with "neutral"; this project has none
    expect(statusOf(result)).toBe(400);
    expect(payload<Refusal>(result).errors).toEqual([
      { line: 3, message: 'Gold answer: Unknown label: neutral' },
      { line: 4, message: 'Qualification questions need a _gold answer' },
    ]);
    expect(await prisma.task.count()).toBe(0);
  });

  it('is for managers of the project\u2019s own organisation only', async () => {
    const { org, project } = await setup();
    const post = async (cookie: string) =>
      statusOf(
        await run(
          importAction,
          makeRequest(`/projects/${project.id}/batches/new`, {
            cookie,
            form: { file: upload('t.csv', 'text\nx\n') },
          }),
          { projectId: project.id },
        ),
      );
    const reviewer = await createMember(org.id, 'REVIEWER');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: reviewer.id } });
    expect(await post(await cookieFor(reviewer, org.id))).toBe(403);

    const elsewhere = await createOrg('Elsewhere');
    const outsider = await createMember(elsewhere.id, 'ADMIN');
    expect(await post(await cookieFor(outsider, elsewhere.id))).toBe(404);
    expect(await prisma.task.count()).toBe(0);
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
