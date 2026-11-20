import { inflateRawSync } from 'node:zlib';

import { beforeEach, describe, expect, it } from 'vitest';

import { parseCsv } from '~/domain/csv';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';
import { pseudonym } from '~/models/export.server';
import { action as importAction } from '~/routes/batch-new';
import { loader as downloadLoader } from '~/routes/project-download';
import { loader as exportLoader } from '~/routes/project-export';

import {
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

  it('is not available to annotators, and hides another organisation\u2019s project', async () => {
    const { org, project } = await setup();
    const annotator = await createMember(org.id, 'ANNOTATOR');
    await prisma.projectMember.create({ data: { projectId: project.id, userId: annotator.id } });
    const status = async (user: { id: string }, orgId: string) =>
      statusOf(
        await run(
          downloadLoader,
          makeRequest(`/projects/${project.id}/download`, { cookie: await cookieFor(user, orgId) }),
          { projectId: project.id },
        ),
      );
    expect(await status(annotator, org.id)).toBe(403);
    const elsewhere = await createOrg('Elsewhere');
    const outsider = await createMember(elsewhere.id, 'ADMIN');
    expect(await status(outsider, elsewhere.id)).toBe(404);
    const signedOut = await run(downloadLoader, makeRequest(`/projects/${project.id}/download`), {
      projectId: project.id,
    });
    expect(statusOf(signedOut)).toBe(302);
  });
});

/** The files of a zip, read from its central directory. */
function unzip(bytes: Buffer): Record<string, string> {
  const end = bytes.length - 22;
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = bytes.subarray(start, start + packed);
    files[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    at += 46 + nameLength;
  }
  return files;
}

describe('export formats and what they hold', () => {
  beforeEach(resetDb);

  async function world(schema: object = SCHEMA_TEMPLATES.text_classification) {
    const org = await createOrg();
    const pm = await createMember(org.id, 'PROJECT_MANAGER');
    const ann = await createMember(org.id, 'ANNOTATOR', { email: 'ann@example.test' });
    const project = await createTestProject(org.id, {
      name: 'Streets',
      schema,
      reviewRequired: false,
    });
    const cookie = await cookieFor(pm, org.id);
    const download = async (query: string, projectId = project.id) =>
      (await run(
        downloadLoader,
        makeRequest(`/projects/${projectId}/download?${query}`, { cookie }),
        {
          projectId,
        },
      )) as Response;
    return { org, pm, ann, project, cookie, download };
  }

  it('names annotators by a pseudonym unless the address is asked for', async () => {
    const { org, ann, project, download } = await world();
    await createTasks(project.id, [{ text: 'good' }]);
    await submitWork(project, ann.id, { labels: ['positive'] });
    const name = pseudonym(project.id, ann.id);
    expect(name).toMatch(/^ann_[0-9a-f]{8}$/);

    const lines = async (query: string) =>
      JSON.parse((await (await download(query)).text()).trim());
    expect((await lines('format=jsonl')).annotations[0].annotator).toBe(name);
    // the same in every export of the project, in every format
    const csv = parseCsv(await (await download('format=csv')).text());
    expect(csv.rows.map((r) => r.values[3])).toEqual([name, 'consensus']);
    expect(await (await download('format=jsonl')).text()).not.toContain('ann@example.test');

    expect((await lines('format=jsonl&annotators=email')).annotations[0].annotator).toBe(
      'ann@example.test',
    );
    // another project gives the same person another name
    const other = await createTestProject(org.id, { name: 'Other', reviewRequired: false });
    expect(pseudonym(other.id, ann.id)).not.toBe(name);
  });

  it('declares utf-8, a file name and no sniffing', async () => {
    const { project, download } = await world();
    await createTasks(project.id, [{ text: 'good' }]);
    const jsonl = await download('format=jsonl&scope=all');
    expect(jsonl.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8');
    expect(jsonl.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csv = await download('format=csv&scope=all');
    expect(csv.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('Content-Disposition')).toBe('attachment; filename="streets-all.csv"');
  });

  it('makes csv cells safe for a spreadsheet', async () => {
    const { ann, project, download } = await world();
    const batch = await prisma.batch.create({
      data: { projectId: project.id, name: '=cmd|batch', format: 'CSV' },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        batchId: batch.id,
        position: 1,
        externalId: '@SUM(1+1)',
        data: { text: '-2+3' },
      },
    });
    await submitWork(project, ann.id, { labels: ['positive'] });

    const text = await (await download('format=csv')).text();
    const table = parseCsv(text);
    for (const row of table.rows) {
      expect(row.values.slice(1, 3)).toEqual(["'@SUM(1+1)", "'=cmd|batch"]);
      for (const cell of row.values) expect(cell).not.toMatch(/^[=+\-@]/);
    }
  });

  it('pages through a large project without losing or repeating a task', async () => {
    const { project, download } = await world();
    const tasks = await createTasks(
      project.id,
      Array.from({ length: 450 }, (_, i) => ({ text: `task ${i}` })),
    );
    // two imports at the same moment can give two tasks one position
    await prisma.task.update({ where: { id: tasks[200].id }, data: { position: 200 } });
    await prisma.task.update({ where: { id: tasks[201].id }, data: { position: 200 } });

    const lines = (await (await download('format=jsonl&scope=all')).text()).trimEnd().split('\n');
    const ids = lines.map((line) => JSON.parse(line).task_id);
    expect(ids).toHaveLength(450);
    expect(new Set(ids).size).toBe(450);
    expect(ids.slice(0, 3)).toEqual(tasks.slice(0, 3).map((t) => t.id));
    expect(ids.at(-1)).toBe(tasks.at(-1)!.id);
  });

  it('exports nothing for a batch of another project', async () => {
    const { org, ann, project, download } = await world();
    await createTasks(project.id, [{ text: 'mine' }]);
    const other = await createTestProject(org.id, { name: 'Other', reviewRequired: false });
    const [foreign] = await createTasks(other.id, [{ text: 'not mine' }]);
    await submitWork(other, ann.id, { labels: ['positive'] });

    const text = await (await download(`format=jsonl&scope=all&batch=${foreign.batchId}`)).text();
    expect(text).toBe('');
    const all = await (await download('format=jsonl&scope=all')).text();
    expect(all).toContain('mine');
    expect(all).not.toContain('not mine');
  });

  it('downloads conll for an entity project and counts spans that do not line up', async () => {
    const { ann, project, cookie, download } = await world(SCHEMA_TEMPLATES.ner);
    await createTasks(project.id, [
      { text: 'Ada met Grace in Paris.' },
      { text: 'Not labeled yet.' },
    ]);
    await submitWork(project, ann.id, {
      spans: [
        { start: 0, end: 3, label: 'PERSON' },
        // "Gra", half a word
        { start: 8, end: 11, label: 'PERSON' },
        { start: 17, end: 22, label: 'LOCATION' },
      ],
    });

    const response = await download('format=conll&scope=all');
    expect(response.headers.get('Content-Disposition')).toContain('streets-all.conll');
    expect(await response.text()).toBe(
      'Ada B-PERSON\nmet O\nGrace B-PERSON\nin O\nParis B-LOCATION\n. O\n\n',
    );
    // coco is for boxes only
    expect((await download('format=coco')).status).toBe(400);

    const page = (path: string) =>
      run(exportLoader, makeRequest(path, { cookie }), { projectId: project.id });
    const plain = payload<{ formats: Array<{ name: string }>; alignment: unknown }>(
      await page(`/projects/${project.id}/export`),
    );
    expect(plain.formats.map((f) => f.name)).toEqual(['jsonl', 'csv', 'conll']);
    expect(plain.alignment).toBeNull();
    const checked = payload<{ alignment: unknown }>(
      await page(`/projects/${project.id}/export?check=conll`),
    );
    expect(checked.alignment).toEqual({ spans: 3, misaligned: 1 });
  });

  it('downloads yolo and pascal voc archives for a box project', async () => {
    const { ann, project, cookie, download } = await world({
      kind: 'bbox',
      imageField: 'image_url',
      labels: ['car', 'person'],
    });
    await createTasks(project.id, [
      { image_url: 'https://cdn.example.test/a/street-1.jpg', width: 640, height: 400 },
      { image_url: '/demo/street-1.svg', width: 640, height: 400 },
    ]);
    await submitWork(project, ann.id, {
      imageWidth: 640,
      imageHeight: 400,
      boxes: [{ x: 64, y: 40, w: 128, h: 80, label: 'person' }],
    });

    const yolo = await download('format=yolo&scope=all');
    expect(yolo.headers.get('Content-Type')).toBe('application/zip');
    expect(yolo.headers.get('Content-Disposition')).toContain('streets-all.yolo.zip');
    const files = unzip(Buffer.from(await yolo.arrayBuffer()));
    expect(Object.keys(files)).toEqual(['classes.txt', 'labels/street-1.txt', 'manifest.csv']);
    expect(files['classes.txt']).toBe('car\nperson\n');
    expect(files['labels/street-1.txt']).toBe('1 0.2 0.2 0.2 0.2\n');
    // both tasks are listed; the one without a label has no file
    expect(parseCsv(files['manifest.csv']).rows.map((r) => r.values[0])).toEqual([
      'labels/street-1.txt',
      '',
    ]);

    const voc = unzip(Buffer.from(await (await download('format=voc')).arrayBuffer()));
    expect(Object.keys(voc)).toEqual(['classes.txt', 'annotations/street-1.xml', 'manifest.csv']);
    expect(voc['annotations/street-1.xml']).toContain('<name>person</name>');
    expect(voc['annotations/street-1.xml']).toContain('<xmax>192</xmax>');

    const page = payload<{ formats: Array<{ name: string }> }>(
      await run(exportLoader, makeRequest(`/projects/${project.id}/export`, { cookie }), {
        projectId: project.id,
      }),
    );
    expect(page.formats.map((f) => f.name)).toEqual(['jsonl', 'csv', 'coco', 'yolo', 'voc']);
  });
});

describe('importing an export again', () => {
  beforeEach(resetDb);

  const cases = [
    {
      name: 'a classification project',
      schema: { ...SCHEMA_TEMPLATES.text_classification, multiple: true },
      rows: [
        { id: 'r-1', text: 'Fine, "mostly"\nand a second line', source: 'web' },
        { id: '=2', text: 'Starts with a formula sign', meta: { stars: 2 } },
        { text: 'No id and no answer yet' },
      ],
      answers: [{ labels: ['positive', 'neutral'] }, { labels: ['negative'] }],
    },
    {
      name: 'a box project',
      schema: SCHEMA_TEMPLATES.bbox,
      rows: [
        { id: 'img-1', image_url: 'https://cdn.example.test/a.jpg', width: 640, height: 400 },
        { id: 'img-2', image_url: '/demo/street-1.svg' },
        { id: 'img-3', image_url: '/demo/street-2.svg' },
      ],
      answers: [
        {
          imageWidth: 640,
          imageHeight: 400,
          boxes: [
            { x: 64.5, y: 40, w: 128, h: 80.5, label: 'car' },
            { x: 300, y: 100, w: 20, h: 60, label: 'person' },
          ],
        },
        { imageWidth: 800, imageHeight: 600, boxes: [] },
      ],
    },
  ];

  for (const { name, schema, rows, answers } of cases) {
    for (const format of ['jsonl', 'csv']) {
      it(`brings back the tasks and labels of ${name} from ${format}`, async () => {
        const org = await createOrg();
        const pm = await createMember(org.id, 'PROJECT_MANAGER');
        const ann = await createMember(org.id, 'ANNOTATOR');
        const cookie = await cookieFor(pm, org.id);
        const source = await createTestProject(org.id, {
          name: 'Source',
          schema,
          reviewRequired: false,
        });
        // imported through the route, so the tasks are what an import makes of the rows
        const upload = async (projectId: string, fileName: string, content: BlobPart) =>
          run(
            importAction,
            makeRequest(`/projects/${projectId}/batches/new`, {
              cookie,
              form: { file: new File([content], fileName) },
            }),
            { projectId },
          );
        const lines = rows.map((row) => JSON.stringify(row)).join('\n');
        expect(statusOf(await upload(source.id, 'tasks.jsonl', lines))).toBe(302);
        for (const answer of answers) await submitWork(source, ann.id, answer);

        const exported = (await run(
          downloadLoader,
          makeRequest(`/projects/${source.id}/download?format=${format}&scope=all`, { cookie }),
          { projectId: source.id },
        )) as Response;
        const file = Buffer.from(await exported.arrayBuffer());

        const target = await createTestProject(org.id, { name: 'Target', schema });
        const imported = await upload(target.id, `export.${format}`, file);

        const tasks = (projectId: string) =>
          prisma.task.findMany({ where: { projectId }, orderBy: { position: 'asc' } });
        const before = await tasks(source.id);
        const after = await tasks(target.id);
        // a csv export has no row for a task without accepted work
        const expected = format === 'csv' ? before.filter((t) => t.consensus !== null) : before;
        expect(statusOf(imported)).toBe(302);
        expect(after.map((t) => [t.externalId, t.data])).toEqual(
          expected.map((t) => [t.externalId, t.data]),
        );
        // the label of each task: its consensus there, its gold answer here
        expect(after.map((t) => t.goldAnswer)).toEqual(expected.map((t) => t.consensus));
        expect(after.map((t) => t.isGold)).toEqual(expected.map((t) => t.consensus !== null));
        expect(expected.filter((t) => t.consensus !== null)).toHaveLength(answers.length);
      });
    }
  }
});
