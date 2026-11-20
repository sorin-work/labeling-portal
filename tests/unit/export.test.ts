import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import type { Answer, BboxAnswer } from '~/domain/answers';
import { parseCsv } from '~/domain/csv';
import {
  conllBlock,
  entryBaseName,
  EXPORT_FORMATS,
  exportFormatsFor,
  findExportFormat,
  finalLabel,
  imageFileName,
  toCoco,
  toCsvExport,
  toJsonl,
  UniqueNames,
  vocXml,
  yoloLabels,
  type ExportContext,
  type ExportTask,
} from '~/domain/export';
import { parseImport } from '~/domain/import';
import { SCHEMA_TEMPLATES, type SchemaKind, type TaskSchema } from '~/domain/task-schema';
import { isSafeEntryName } from '~/domain/zip';

const base = {
  id: 't1',
  externalId: 'ext-1',
  batch: 'March',
  status: 'COMPLETE',
  agreement: 1,
};

describe('toJsonl', () => {
  it('writes one line per task with span text added', () => {
    const task: ExportTask = {
      ...base,
      data: { text: 'Ada met Charles in London.' },
      consensus: { spans: [{ start: 0, end: 3, label: 'PERSON' }] },
      annotations: [
        {
          annotator: 'ann@example.test',
          answer: { spans: [{ start: 0, end: 3, label: 'PERSON' }] },
          reviewStatus: 'APPROVED',
          qaScore: 5,
          activeSeconds: 42,
          submittedAt: '2026-03-01T10:00:00.000Z',
        },
      ],
    };
    const lines = toJsonl(SCHEMA_TEMPLATES.ner, [task]).trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({
      task_id: 't1',
      external_id: 'ext-1',
      status: 'complete',
      consensus: { spans: [{ start: 0, end: 3, label: 'PERSON', text: 'Ada' }] },
    });
    expect(row.annotations[0]).toMatchObject({
      annotator: 'ann@example.test',
      review_status: 'approved',
    });
  });
});

describe('entity text after an emoji', () => {
  it('exports the covered text', () => {
    const text = 'Great day \u{1F600} with Maria in Lisbon';
    const start = text.indexOf('Maria');
    const task: ExportTask = {
      ...base,
      data: { text },
      consensus: { spans: [{ start, end: start + 5, label: 'PERSON' }] },
      annotations: [],
    };
    const row = JSON.parse(toJsonl(SCHEMA_TEMPLATES.ner, [task]));
    expect(row.consensus.spans[0].text).toBe('Maria');
    expect(toCsvExport(SCHEMA_TEMPLATES.ner, [task])).toContain('PERSON:Maria');
  });
});

describe('toCsvExport', () => {
  it('flattens pairwise answers into rubric columns', () => {
    const task: ExportTask = {
      ...base,
      data: { prompt: 'p', response_a: 'a', response_b: 'b' },
      consensus: null,
      annotations: [
        {
          annotator: 'ann@example.test',
          answer: {
            preference: 'A',
            scores: {
              a: { helpfulness: 5, accuracy: 4, safety: 5 },
              b: { helpfulness: 2, accuracy: 3, safety: 5 },
            },
            rationale: 'A is right, "B" is vague',
          },
          reviewStatus: 'FIXED',
          qaScore: 3,
          activeSeconds: 90,
          submittedAt: null,
        },
      ],
    };
    const table = parseCsv(toCsvExport(SCHEMA_TEMPLATES.pairwise, [task]));
    expect(table.header).toEqual([
      'task_id',
      'external_id',
      'batch',
      'annotator',
      'review_status',
      'qa_score',
      'active_seconds',
      'preference',
      'a_helpfulness',
      'b_helpfulness',
      'a_accuracy',
      'b_accuracy',
      'a_safety',
      'b_safety',
      'rationale',
      'submitted_at',
      'answer',
      'data',
      'task_status',
    ]);
    const [row] = table.rows.map((r) => r.values);
    expect(row.at(-1)).toBe('complete');
    expect(row.slice(0, 16)).toEqual([
      't1',
      'ext-1',
      'March',
      'ann@example.test',
      'fixed',
      '3',
      '90',
      'A',
      '5',
      '2',
      '4',
      '3',
      '5',
      '5',
      'A is right, "B" is vague',
      '',
    ]);
    // the whole answer and the whole task, which is what an import reads back
    expect(JSON.parse(row[16])).toEqual(task.annotations[0].answer);
    expect(JSON.parse(row[17])).toEqual(task.data);
  });

  it('adds a consensus row for classification', () => {
    const task: ExportTask = {
      ...base,
      data: { text: 'x' },
      consensus: { labels: ['neutral'] },
      annotations: [],
    };
    const lines = toCsvExport(SCHEMA_TEMPLATES.text_classification, [task]).trimEnd().split('\r\n');
    expect(lines[1]).toBe(
      't1,ext-1,March,consensus,,,,neutral,,"{""labels"":[""neutral""]}","{""text"":""x""}",complete',
    );
  });

  it('writes the submission time as an ISO date', () => {
    const task: ExportTask = {
      ...base,
      data: { text: 'x' },
      consensus: null,
      annotations: [
        {
          annotator: 'ann_1a2b3c4d',
          answer: { labels: ['neutral'] },
          reviewStatus: 'APPROVED',
          qaScore: null,
          activeSeconds: 12,
          submittedAt: '2026-03-10T09:05:00.000Z',
        },
      ],
    };
    const [row] = parseCsv(toCsvExport(SCHEMA_TEMPLATES.text_classification, [task])).rows;
    expect(row.values[8]).toBe('2026-03-10T09:05:00.000Z');
  });

  it('guards cells that a spreadsheet would run as a formula', () => {
    const task: ExportTask = {
      ...base,
      externalId: '=1+1',
      batch: '@batch',
      data: { prompt: '=cmd|x', response_a: 'a', response_b: 'b' },
      consensus: null,
      annotations: [
        {
          annotator: '+ann',
          answer: {
            preference: 'A',
            scores: { a: { helpfulness: 5 }, b: { helpfulness: 1 } },
            rationale: '-2 for B, =HYPERLINK("http://x.test")',
          },
          reviewStatus: 'APPROVED',
          qaScore: 5,
          activeSeconds: 90,
          submittedAt: null,
        },
      ],
    };
    const [row] = parseCsv(toCsvExport(SCHEMA_TEMPLATES.pairwise, [task])).rows;
    expect(row.values.slice(1, 4)).toEqual(["'=1+1", "'@batch", "'+ann"]);
    expect(row.values[14]).toBe(`'-2 for B, =HYPERLINK("http://x.test")`);
    // numbers stay numbers, and the JSON cells start with a brace
    expect(row.values[5]).toBe('5');
    expect(row.values[17].startsWith('{')).toBe(true);
    for (const cell of row.values) expect(cell).not.toMatch(/^[=+\-@]/);
  });
});

describe('toCoco', () => {
  it('builds images, categories and annotations from consensus boxes', () => {
    const task: ExportTask = {
      ...base,
      data: { image_url: '/demo/street-1.svg' },
      consensus: {
        imageWidth: 640,
        imageHeight: 400,
        boxes: [
          { x: 10, y: 20, w: 30, h: 40, label: 'person' },
          { x: 100, y: 120, w: 50, h: 20, label: 'car' },
        ],
      },
      annotations: [],
    };
    const coco = toCoco(SCHEMA_TEMPLATES.bbox, [task], 'Streets', new Date('2026-04-01T00:00:00Z'));
    expect(coco.images).toEqual([
      { id: 1, file_name: '/demo/street-1.svg', width: 640, height: 400, task_id: 't1' },
    ]);
    expect(coco.categories.map((c) => c.name)).toEqual(['car', 'person', 'bicycle']);
    expect(coco.annotations[0]).toEqual({
      id: 1,
      image_id: 1,
      category_id: 2,
      bbox: [10, 20, 30, 40],
      area: 1200,
      iscrowd: 0,
    });
  });

  it('refuses other project kinds', () => {
    expect(() => toCoco(SCHEMA_TEMPLATES.ner, [], 'x')).toThrow(/only available/);
  });
});

/** Runs a format's writer over tasks and joins what it gives. */
async function written(name: string, schema: TaskSchema, tasks: ExportTask[]): Promise<Buffer> {
  const format = findExportFormat(name)!;
  const context: ExportContext = {
    schema,
    projectName: 'Street scenes',
    now: new Date('2026-11-20T10:30:44Z'),
  };
  async function* one() {
    for (const task of tasks) yield task;
  }
  const parts: Buffer[] = [];
  for await (const chunk of format.write(context, one())) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

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

const annotation = (answer: Answer, annotator = 'ann_1a2b3c4d') => ({
  annotator,
  answer,
  reviewStatus: 'APPROVED',
  qaScore: 4,
  activeSeconds: 30,
  submittedAt: '2026-03-10T09:05:00.000Z',
});

describe('the table of formats', () => {
  it('has fixed names, and offers each kind its own formats', () => {
    expect(EXPORT_FORMATS.map((f) => f.name)).toEqual([
      'jsonl',
      'csv',
      'coco',
      'yolo',
      'voc',
      'conll',
    ]);
    const names = (kind: SchemaKind) => exportFormatsFor(kind).map((f) => f.name);
    expect(names('text_classification')).toEqual(['jsonl', 'csv']);
    expect(names('image_classification')).toEqual(['jsonl', 'csv']);
    expect(names('pairwise')).toEqual(['jsonl', 'csv']);
    expect(names('ner')).toEqual(['jsonl', 'csv', 'conll']);
    expect(names('bbox')).toEqual(['jsonl', 'csv', 'coco', 'yolo', 'voc']);
    expect(findExportFormat('xlsx')).toBeNull();
    for (const format of EXPORT_FORMATS) {
      expect(format.label && format.hint && format.extension).toBeTruthy();
      if (!format.archive) expect(format.contentType).toContain('charset=utf-8');
    }
  });

  it('writes the same through the stream as in one piece', async () => {
    const tasks: ExportTask[] = [
      { ...base, data: { text: 'x' }, consensus: { labels: ['neutral'] }, annotations: [] },
      { ...base, id: 't2', data: { text: 'y' }, consensus: null, annotations: [] },
    ];
    const schema = SCHEMA_TEMPLATES.text_classification;
    expect((await written('jsonl', schema, tasks)).toString()).toBe(toJsonl(schema, tasks));
    expect((await written('csv', schema, tasks)).toString()).toBe(toCsvExport(schema, tasks));
    expect((await written('csv', schema, [])).toString()).toBe(toCsvExport(schema, []));
    expect((await written('jsonl', schema, [])).toString()).toBe('');
  });
});

describe('box formats', () => {
  const schema = SCHEMA_TEMPLATES.bbox;
  const boxes: BboxAnswer = {
    imageWidth: 640,
    imageHeight: 400,
    boxes: [
      { x: 64, y: 40, w: 128, h: 80, label: 'car' },
      { x: 320, y: 200, w: 32, h: 100, label: 'bicycle' },
    ],
  };
  const tasks: ExportTask[] = [
    {
      ...base,
      data: { image_url: 'https://cdn.example.test/img/Street 1.JPG?size=large' },
      consensus: boxes,
      annotations: [],
    },
    // no consensus, one accepted answer: that answer is the label
    {
      ...base,
      id: 't2',
      externalId: 'ext-2',
      data: { image_url: '/demo/street-1.svg' },
      consensus: null,
      annotations: [annotation({ ...boxes, boxes: [boxes.boxes[0]] })],
    },
    // two answers and no consensus: no label yet
    {
      ...base,
      id: 't3',
      externalId: '../../etc/passwd',
      data: { image_url: 'https://cdn.example.test/' },
      consensus: null,
      annotations: [annotation(boxes), annotation(boxes, 'ann_2')],
    },
    // the same file name as the first task
    {
      ...base,
      id: 't4',
      externalId: null,
      data: { image_url: 'http://other.example.test/street_1.jpg' },
      consensus: { ...boxes, boxes: [] },
      annotations: [],
    },
  ];

  it('takes the consensus, or the one accepted answer, as the label', () => {
    const count = (task: ExportTask) => (finalLabel(task) as BboxAnswer | null)?.boxes.length;
    expect(tasks.map((task) => count(task) ?? null)).toEqual([2, 1, null, 0]);
  });

  it('writes yolo label files with class indexes and shares of the image', async () => {
    const files = unzip(await written('yolo', schema, tasks));
    expect(Object.keys(files)).toEqual([
      'classes.txt',
      'labels/Street_1.txt',
      'labels/street-1.txt',
      'labels/street_1-2.txt',
      'manifest.csv',
    ]);
    expect(files['classes.txt']).toBe('car\nperson\nbicycle\n');
    // class, centre x, centre y, width, height
    expect(files['labels/Street_1.txt']).toBe('0 0.2 0.2 0.2 0.2\n2 0.525 0.625 0.05 0.25\n');
    expect(files['labels/street-1.txt']).toBe('0 0.2 0.2 0.2 0.2\n');
    // labeled, with nothing in the image
    expect(files['labels/street_1-2.txt']).toBe('');
    const manifest = parseCsv(files['manifest.csv']);
    expect(manifest.header).toEqual([
      'file',
      'task_id',
      'external_id',
      'image',
      'width',
      'height',
      'boxes',
    ]);
    expect(manifest.rows.map((r) => r.values)).toEqual([
      ['labels/Street_1.txt', 't1', 'ext-1', tasks[0].data.image_url, '640', '400', '2'],
      ['labels/street-1.txt', 't2', 'ext-2', '/demo/street-1.svg', '640', '400', '1'],
      // listed without a file: it has no label, which is not the same as no boxes
      ['', 't3', '../../etc/passwd', 'https://cdn.example.test/', '', '', ''],
      [
        'labels/street_1-2.txt',
        't4',
        '',
        'http://other.example.test/street_1.jpg',
        '640',
        '400',
        '0',
      ],
    ]);
  });

  it('writes one pascal voc file per labeled image', async () => {
    const files = unzip(await written('voc', schema, tasks));
    expect(Object.keys(files)).toEqual([
      'classes.txt',
      'annotations/Street_1.xml',
      'annotations/street-1.xml',
      'annotations/street_1-2.xml',
      'manifest.csv',
    ]);
    const xml = files['annotations/Street_1.xml'];
    expect(xml).toContain('<filename>Street_1.JPG</filename>');
    expect(xml).toContain('<path>https://cdn.example.test/img/Street 1.JPG?size=large</path>');
    expect(xml).toContain('<width>640</width>');
    expect(xml.match(/<object>/g)).toHaveLength(2);
    expect(xml).toContain(
      '<name>car</name>\n    <pose>Unspecified</pose>\n    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <bndbox>\n      <xmin>64</xmin>\n      <ymin>40</ymin>\n      <xmax>192</xmax>\n      <ymax>120</ymax>',
    );
    expect(files['annotations/street_1-2.xml']).not.toContain('<object>');
  });

  it('escapes what goes into xml', () => {
    const xml = vocXml('a<b>.jpg', 'https://x.test/a.jpg?a=1&b="2"', {
      imageWidth: 10,
      imageHeight: 10,
      boxes: [{ x: 0, y: 0, w: 5, h: 5, label: '<script>&"\u0001' }],
    });
    expect(xml).toContain('<filename>a&lt;b&gt;.jpg</filename>');
    expect(xml).toContain('<path>https://x.test/a.jpg?a=1&amp;b=&quot;2&quot;</path>');
    expect(xml).toContain('<name>&lt;script&gt;&amp;&quot;</name>');
  });

  it('leaves out boxes with a label the schema does not have, and images without a size', () => {
    const labels = ['car', 'person'];
    const answer = { ...boxes, boxes: [...boxes.boxes, { ...boxes.boxes[0], label: 'tram' }] };
    expect(yoloLabels(labels, answer)).toBe('0 0.2 0.2 0.2 0.2\n');
    expect(yoloLabels(labels, { ...boxes, imageWidth: 0 })).toBe('');
  });

  it('writes coco through the stream as it does in one piece', async () => {
    const now = new Date('2026-11-20T10:30:44Z');
    const streamed = JSON.parse((await written('coco', schema, tasks)).toString());
    expect(streamed).toEqual(toCoco(schema, tasks, 'Street scenes', now));
    expect(streamed.info.date_created).toBe('2026-11-20T10:30:44.000Z');
    expect(JSON.parse((await written('coco', schema, [])).toString())).toMatchObject({
      images: [],
      annotations: [],
    });
  });
});

describe('file names in an archive', () => {
  const task = (data: Record<string, unknown>, externalId: string | null = null): ExportTask => ({
    ...base,
    id: 'task_1',
    externalId,
    data,
    consensus: null,
    annotations: [],
  });

  it('come from the image file, or the external id, or the task id', () => {
    const name = (image: unknown, externalId: string | null = null) =>
      entryBaseName(task({ image_url: image }, externalId), 'image_url');
    expect(name('https://cdn.example.test/a/b/street-1.jpg?x=1#frag')).toBe('street-1');
    expect(name('/demo/street-1.svg')).toBe('street-1');
    expect(name('https://cdn.example.test/img/caf%C3%A9%20photo.png')).toBe('cafe_photo');
    expect(name('https://cdn.example.test/', 'ext 7')).toBe('ext_7');
    expect(name('https://cdn.example.test', null)).toBe('task_1');
    expect(name(undefined, null)).toBe('task_1');
  });

  it('never hold a folder or a way out of one', () => {
    const hostile = [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      '/absolute/path',
      'C:\\temp\\x',
      '....',
      'a/../../b',
      '\u0000nul',
      '.hidden',
    ];
    for (const externalId of hostile) {
      const name = entryBaseName(task({ image_url: '' }, externalId), 'image_url');
      expect(name, externalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(isSafeEntryName(`labels/${name}.txt`), externalId).toBe(true);
    }
    expect(imageFileName('https://x.test/a/../../etc/passwd')).toBe('passwd');
    expect(entryBaseName(task({ image_url: 'https://x.test/..%2F..%2Fup.png' }), 'image_url')).toBe(
      'up',
    );
  });

  it('get a number when two tasks share one', () => {
    const names = new UniqueNames();
    expect(['cat', 'dog', 'cat', 'Cat', 'cat-2', 'cat'].map((n) => names.take(n))).toEqual([
      'cat',
      'dog',
      'cat-2',
      'Cat-3',
      'cat-2-2',
      'cat-4',
    ]);
  });
});

describe('conll', () => {
  const schema = SCHEMA_TEMPLATES.ner;
  const text = 'Ada Lovelace met Charles Babbage in London.';
  const spans = [
    { start: 0, end: 12, label: 'PERSON' },
    { start: 36, end: 42, label: 'LOCATION' },
  ];
  const task = (answer: Answer | null, extra: Partial<ExportTask> = {}): ExportTask => ({
    ...base,
    data: { text },
    consensus: answer,
    annotations: [],
    ...extra,
  });

  it('writes a token and its tag per line and an empty line after each task', async () => {
    const out = await written('conll', schema, [
      task({ spans }),
      // no label yet: left out, not written as text without entities
      task(null, { id: 't2' }),
      // labeled as having no entities
      task({ spans: [] }, { id: 't3', data: { text: 'Nothing here.' } }),
      // one accepted answer stands in for the consensus
      task(null, { id: 't4', annotations: [annotation({ spans: [spans[1]] })] }),
    ]);
    expect(out.toString()).toBe(
      'Ada B-PERSON\nLovelace I-PERSON\nmet O\nCharles O\nBabbage O\nin O\nLondon B-LOCATION\n. O\n\n' +
        'Nothing O\nhere O\n. O\n\n' +
        'Ada O\nLovelace O\nmet O\nCharles O\nBabbage O\nin O\nLondon B-LOCATION\n. O\n\n',
    );
  });

  it('counts the spans that had to be widened to whole tokens', () => {
    const block = conllBlock(
      schema,
      task({ spans: [{ start: 4, end: 9, label: 'PERSON' }, spans[1]] }),
    );
    expect(block).toMatchObject({ spans: 2, misaligned: 1 });
    expect(block?.text).toContain('Lovelace B-PERSON\n');
    expect(conllBlock(schema, task(null))).toBeNull();
    expect(conllBlock(schema, task({ spans: [] }, { data: { text: '  ' } }))).toBeNull();
  });
});

describe('importing an export again', () => {
  const kinds: Array<{
    name: string;
    schema: TaskSchema;
    data: Array<Record<string, unknown>>;
    consensus: Answer;
    gold: Answer;
  }> = [
    {
      name: 'text classification',
      schema: { ...SCHEMA_TEMPLATES.text_classification, multiple: true },
      data: [{ id: 'r-1', text: 'Fine, "mostly"', source: 'web' }, { text: 'No id, two\nlines' }],
      consensus: { labels: ['positive', 'neutral'] },
      gold: { labels: ['positive', 'neutral'] },
    },
    {
      name: 'image classification',
      schema: { ...SCHEMA_TEMPLATES.image_classification, multiple: true },
      data: [
        { id: 'photo-1', image_url: 'https://cdn.example.test/p.jpg', width: 800 },
        { id: 'photo-2', image_url: '/demo/street-2.svg' },
      ],
      consensus: { labels: ['usable', 'blurry'] },
      gold: { labels: ['usable', 'blurry'] },
    },
    {
      name: 'named entities',
      schema: SCHEMA_TEMPLATES.ner,
      data: [
        { id: 7, text: 'Ada Lovelace met Zoë in Kraków.' },
        { id: '=8', text: 'Grace Hopper.' },
      ],
      consensus: { spans: [{ start: 0, end: 12, label: 'PERSON' }] },
      gold: { spans: [{ start: 0, end: 12, label: 'PERSON' }] },
    },
    {
      name: 'pairwise',
      schema: SCHEMA_TEMPLATES.pairwise,
      data: [
        { id: 'p1', prompt: 'p', response_a: 'a', response_b: 'b', meta: { model: 'x', n: 3 } },
        { id: '-p2', prompt: '+1?', response_a: '@a', response_b: '=b' },
      ],
      consensus: {
        preference: 'A',
        scores: {
          a: { helpfulness: 4.5, accuracy: 4, safety: 5 },
          b: { helpfulness: 2, accuracy: 3, safety: 5 },
        },
        rationale: '',
      },
      // a gold answer for a comparison is the preference
      gold: { preference: 'A', scores: { a: {}, b: {} }, rationale: '' },
    },
    {
      name: 'bounding boxes',
      schema: SCHEMA_TEMPLATES.bbox,
      data: [
        { id: 'img-1', image_url: 'https://cdn.example.test/a.jpg', width: 640, height: 400 },
        { id: 'img-2', image_url: '/demo/street-1.svg' },
      ],
      consensus: {
        imageWidth: 640,
        imageHeight: 400,
        boxes: [{ x: 64.5, y: 40, w: 128, h: 80.5, label: 'car' }],
      },
      gold: {
        imageWidth: 640,
        imageHeight: 400,
        boxes: [{ x: 64.5, y: 40, w: 128, h: 80.5, label: 'car' }],
      },
    },
  ];

  for (const kind of kinds) {
    const tasks: ExportTask[] = kind.data.map((data, i) => ({
      id: `task-${i}`,
      externalId: data.id === undefined ? null : String(data.id),
      batch: 'March',
      status: 'COMPLETE',
      data,
      // the second task was answered but has no consensus
      consensus: i === 0 ? kind.consensus : null,
      agreement: i === 0 ? 1 : null,
      annotations: [annotation(kind.consensus), annotation(kind.consensus, 'ann_2')],
    }));
    const expected = tasks.map((task, i) => ({
      externalId: task.externalId,
      data: task.data,
      gold: i === 0 ? kind.gold : undefined,
    }));
    const back = (text: string, format: 'JSONL' | 'CSV' | 'JSON') => {
      const result = parseImport(text, format, kind.schema);
      expect(result.errors).toEqual([]);
      return result.rows.map(({ externalId, data, gold }) => ({ externalId, data, gold }));
    };

    it(`brings back the tasks and labels of a json lines export (${kind.name})`, () => {
      expect(back(toJsonl(kind.schema, tasks), 'JSONL')).toEqual(expected);
      // the same lines as one array
      const array = `[${toJsonl(kind.schema, tasks).trimEnd().split('\n').join(',')}]`;
      expect(back(array, 'JSON')).toEqual(expected);
    });

    it(`brings back the tasks and labels of a csv export (${kind.name})`, () => {
      expect(back(toCsvExport(kind.schema, tasks), 'CSV')).toEqual(expected);
    });
  }

  it('brings a task back without a label when its multi-label consensus is empty', () => {
    const schema = { ...SCHEMA_TEMPLATES.text_classification, multiple: true };
    const task: ExportTask = {
      ...base,
      data: { text: 'Nobody agreed' },
      consensus: { labels: [] },
      annotations: [],
    };
    for (const [text, format] of [
      [toJsonl(schema, [task]), 'JSONL'],
      [toCsvExport(schema, [task]), 'CSV'],
    ] as const) {
      const result = parseImport(text, format, schema);
      expect(result.errors).toEqual([]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        externalId: 'ext-1',
        data: { text: 'Nobody agreed' },
      });
      expect(result.rows[0].gold).toBeUndefined();
    }
  });

  it('checks a label that comes back against the schema as it is now', () => {
    const before = SCHEMA_TEMPLATES.text_classification;
    const task: ExportTask = {
      ...base,
      data: { text: 'x' },
      consensus: { labels: ['neutral'] },
      annotations: [],
    };
    const narrower = { ...before, labels: ['positive', 'negative'] };
    expect(parseImport(toJsonl(before, [task]), 'JSONL', narrower).errors).toEqual([
      { line: 1, message: 'Gold answer: Unknown label: neutral' },
    ]);
    expect(parseImport(toCsvExport(before, [task]), 'CSV', narrower).errors).toEqual([
      { line: 2, message: 'Gold answer: Unknown label: neutral' },
    ]);
  });

  it('reports a csv export whose json cells were damaged', () => {
    const csv =
      'task_id,external_id,batch,annotator,answer,data\r\n' +
      't1,a,b,consensus,"{""labels"":[""neutral""]}","{""text"": broken"\r\n' +
      't2,b,b,consensus,not json,"{""text"":""ok""}"\r\n';
    expect(parseImport(csv, 'CSV', SCHEMA_TEMPLATES.text_classification).errors).toEqual([
      { line: 2, message: 'The data column does not hold a JSON object' },
      { line: 3, message: 'The answer column does not hold JSON' },
    ]);
  });
});
