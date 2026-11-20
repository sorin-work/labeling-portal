import type {
  Answer,
  BboxAnswer,
  ClassificationAnswer,
  NerAnswer,
  PairwiseAnswer,
} from './answers';
import { toCsvLine, type CsvCell } from './csv';
import { spanText } from './spans';
import type { SchemaKind, TaskSchema } from './task-schema';
import { bioTags } from './tokenize';
import { ZipWriter } from './zip';

/**
 * The export formats. Every format is a writer that takes tasks one at a time
 * and gives the download in pieces, so a project is never held in memory as a
 * whole. The table at the end is what the download route and the export page
 * both read. Field and column names are fixed: `docs/import-export.md` lists
 * them, and files people keep must stay readable.
 */

export type ExportAnnotation = {
  /** a pseudonym or an email address, as the download asked for */
  annotator: string;
  answer: Answer;
  reviewStatus: string | null;
  qaScore: number | null;
  activeSeconds: number;
  /** ISO 8601, UTC */
  submittedAt: string | null;
};

export type ExportTask = {
  id: string;
  externalId: string | null;
  batch: string;
  data: Record<string, unknown>;
  status: string;
  consensus: Answer | null;
  /** where the consensus came from: the accepted answers, or a reviewer in adjudication */
  consensusSource?: 'majority' | 'adjudicated' | null;
  agreement: number | null;
  annotations: ExportAnnotation[];
};

export type ExportContext = { schema: TaskSchema; projectName: string; now: Date };

type Chunk = string | Uint8Array;
type Writer = (context: ExportContext, tasks: AsyncIterable<ExportTask>) => AsyncIterable<Chunk>;

export type ExportFormat = {
  /** the value of `?format=` */
  name: string;
  label: string;
  hint: string;
  /** the project kinds the format exists for; every kind when left out */
  kinds?: readonly SchemaKind[];
  contentType: string;
  extension: string;
  /**
   * "annotations" needs who answered what and when. "labels" only needs the
   * answers, and the loader then leaves the rest of the columns alone.
   */
  needs: 'annotations' | 'labels';
  /** a zip with a file per task; such an export has a limit on how many tasks it takes */
  archive?: boolean;
  write: Writer;
};

/**
 * The one answer a label format takes for a task: the consensus, or the
 * single accepted answer when there is no consensus. Null when the task has
 * no label yet, and such a task gets no labels in those formats.
 */
export function finalLabel(task: ExportTask): Answer | null {
  return task.consensus ?? (task.annotations.length === 1 ? task.annotations[0].answer : null);
}

// JSON Lines ----------------------------------------------------------------

/** Adds the covered text to each span so exports are readable on their own. */
function withSpanText(schema: TaskSchema, data: Record<string, unknown>, answer: Answer | null) {
  if (!answer || schema.kind !== 'ner') return answer;
  const text = String(data[schema.textField] ?? '');
  return {
    spans: (answer as NerAnswer).spans.map((s) => ({ ...s, text: spanText(text, s) })),
  };
}

/** One task as a line of the JSON Lines export, without the line ending. */
export function jsonlLine(schema: TaskSchema, task: ExportTask): string {
  return JSON.stringify({
    task_id: task.id,
    external_id: task.externalId,
    batch: task.batch,
    status: task.status.toLowerCase(),
    data: task.data,
    consensus: withSpanText(schema, task.data, task.consensus),
    agreement: task.agreement,
    annotations: task.annotations.map((a) => ({
      annotator: a.annotator,
      answer: withSpanText(schema, task.data, a.answer),
      review_status: a.reviewStatus?.toLowerCase() ?? null,
      qa_score: a.qaScore,
      active_seconds: a.activeSeconds,
      submitted_at: a.submittedAt,
    })),
    consensus_source: task.consensusSource ?? null,
  });
}

/** One JSON object per task with every accepted annotation and the consensus. */
export function toJsonl(schema: TaskSchema, tasks: ExportTask[]): string {
  return tasks.map((task) => `${jsonlLine(schema, task)}\n`).join('');
}

async function* writeJsonl({ schema }: ExportContext, tasks: AsyncIterable<ExportTask>) {
  for await (const task of tasks) yield `${jsonlLine(schema, task)}\n`;
}

// CSV -------------------------------------------------------------------------

function answerColumns(schema: TaskSchema): string[] {
  switch (schema.kind) {
    case 'text_classification':
      return ['labels'];
    case 'ner':
      return ['entities'];
    case 'pairwise':
      return [
        'preference',
        ...schema.dimensions.flatMap((d) => [`a_${d.key}`, `b_${d.key}`]),
        'rationale',
      ];
    case 'bbox':
      return ['boxes'];
  }
}

function answerCells(
  schema: TaskSchema,
  data: Record<string, unknown>,
  answer: Answer | null,
): CsvCell[] {
  const empty = answerColumns(schema).map(() => '');
  if (!answer) return empty;
  switch (schema.kind) {
    case 'text_classification':
      return [(answer as ClassificationAnswer).labels.join('|')];
    case 'ner': {
      const text = String(data[schema.textField] ?? '');
      return [(answer as NerAnswer).spans.map((s) => `${s.label}:${spanText(text, s)}`).join('; ')];
    }
    case 'pairwise': {
      const p = answer as PairwiseAnswer;
      return [
        p.preference,
        ...schema.dimensions.flatMap((d) => [p.scores.a[d.key] ?? '', p.scores.b[d.key] ?? '']),
        p.rationale,
      ];
    }
    case 'bbox':
      return [JSON.stringify((answer as BboxAnswer).boxes)];
  }
}

/**
 * The columns of the CSV export. The first seven and the answer columns are
 * for reading. `answer` and `data` at the end hold the whole answer and the
 * whole task as JSON, which is what makes the file importable again.
 */
export function csvHeader(schema: TaskSchema): string[] {
  return [
    'task_id',
    'external_id',
    'batch',
    'annotator',
    'review_status',
    'qa_score',
    'active_seconds',
    ...answerColumns(schema),
    'submitted_at',
    'answer',
    'data',
    'task_status',
  ];
}

/** The rows of one task: one per accepted annotation, then the consensus if there is one. */
export function csvRows(schema: TaskSchema, task: ExportTask): CsvCell[][] {
  const data = JSON.stringify(task.data);
  const rows: CsvCell[][] = task.annotations.map((a) => [
    task.id,
    task.externalId,
    task.batch,
    a.annotator,
    a.reviewStatus?.toLowerCase() ?? '',
    a.qaScore,
    a.activeSeconds,
    ...answerCells(schema, task.data, a.answer),
    a.submittedAt,
    JSON.stringify(a.answer),
    data,
    task.status.toLowerCase(),
  ]);
  if (task.consensus) {
    rows.push([
      task.id,
      task.externalId,
      task.batch,
      'consensus',
      '',
      null,
      null,
      ...answerCells(schema, task.data, task.consensus),
      null,
      JSON.stringify(task.consensus),
      data,
      task.status.toLowerCase(),
    ]);
  }
  return rows;
}

/** One row per accepted annotation; consensus rows use "consensus" as the annotator. */
export function toCsvExport(schema: TaskSchema, tasks: ExportTask[]): string {
  return (
    toCsvLine(csvHeader(schema)) +
    tasks.flatMap((task) => csvRows(schema, task).map((row) => toCsvLine(row))).join('')
  );
}

async function* writeCsv({ schema }: ExportContext, tasks: AsyncIterable<ExportTask>) {
  yield toCsvLine(csvHeader(schema));
  for await (const task of tasks) {
    yield csvRows(schema, task)
      .map((row) => toCsvLine(row))
      .join('');
  }
}

// COCO ------------------------------------------------------------------------

type CocoImage = { id: number; file_name: string; width: number; height: number; task_id: string };
type CocoAnnotation = {
  id: number;
  image_id: number;
  category_id: number;
  bbox: [number, number, number, number];
  area: number;
  iscrowd: 0;
};

export type CocoDataset = {
  info: { description: string; date_created: string };
  images: CocoImage[];
  categories: Array<{ id: number; name: string }>;
  annotations: CocoAnnotation[];
};

/**
 * Builds a COCO dataset task by task. Ids are positions in the export, and
 * the format keeps its images and its boxes in two lists, so the boxes have
 * to wait in memory until the images are written. They are a few numbers each.
 */
class CocoBuilder {
  readonly categories: Array<{ id: number; name: string }>;
  readonly annotations: CocoAnnotation[] = [];
  private readonly categoryId: Map<string, number>;
  private images = 0;

  constructor(private readonly schema: Extract<TaskSchema, { kind: 'bbox' }>) {
    this.categories = schema.labels.map((name, i) => ({ id: i + 1, name }));
    this.categoryId = new Map(this.categories.map((c) => [c.name, c.id]));
  }

  add(task: ExportTask): CocoImage {
    const answer = finalLabel(task) as BboxAnswer | null;
    this.images += 1;
    for (const box of answer?.boxes ?? []) {
      const category = this.categoryId.get(box.label);
      if (!category) continue;
      this.annotations.push({
        id: this.annotations.length + 1,
        image_id: this.images,
        category_id: category,
        bbox: [box.x, box.y, box.w, box.h],
        area: Math.round(box.w * box.h * 10) / 10,
        iscrowd: 0,
      });
    }
    return {
      id: this.images,
      file_name: String(task.data[this.schema.imageField] ?? ''),
      width: answer?.imageWidth ?? Number(task.data.width ?? 0),
      height: answer?.imageHeight ?? Number(task.data.height ?? 0),
      task_id: task.id,
    };
  }
}

function boxSchema(schema: TaskSchema, format: string) {
  if (schema.kind !== 'bbox')
    throw new Error(`${format} export is only available for box projects`);
  return schema;
}

/**
 * COCO object-detection format for box projects. Uses the consensus boxes of
 * each task, or the single accepted annotation when there is no consensus.
 */
export function toCoco(
  schema: TaskSchema,
  tasks: ExportTask[],
  description: string,
  now = new Date(),
): CocoDataset {
  const builder = new CocoBuilder(boxSchema(schema, 'COCO'));
  const images = tasks.map((task) => builder.add(task));
  return {
    info: { description, date_created: now.toISOString() },
    images,
    categories: builder.categories,
    annotations: builder.annotations,
  };
}

async function* writeCoco(context: ExportContext, tasks: AsyncIterable<ExportTask>) {
  const builder = new CocoBuilder(boxSchema(context.schema, 'COCO'));
  const info = { description: context.projectName, date_created: context.now.toISOString() };
  yield `{\n"info": ${JSON.stringify(info)},\n"categories": ${JSON.stringify(builder.categories)},\n"images": [`;
  let first = true;
  for await (const task of tasks) {
    yield `${first ? '' : ','}\n${JSON.stringify(builder.add(task))}`;
    first = false;
  }
  yield '\n],\n"annotations": [';
  for (const [i, annotation] of builder.annotations.entries()) {
    yield `${i === 0 ? '' : ','}\n${JSON.stringify(annotation)}`;
  }
  yield '\n]\n}\n';
}

// CoNLL ---------------------------------------------------------------------

export type ConllBlock = { text: string; spans: number; misaligned: number };

/**
 * One task as CoNLL-style lines: a token, a space and its BIO tag per line.
 * Null for a task without a label or without a token, which gets no block:
 * a block of nothing but O would say that the text has no entities.
 */
export function conllBlock(schema: TaskSchema, task: ExportTask): ConllBlock | null {
  if (schema.kind !== 'ner') throw new Error('CoNLL export is only available for entity projects');
  const answer = finalLabel(task) as NerAnswer | null;
  if (!answer) return null;
  const tagged = bioTags(String(task.data[schema.textField] ?? ''), answer.spans);
  if (tagged.tokens.length === 0) return null;
  return {
    text: tagged.tokens.map((token) => `${token.text} ${token.tag}\n`).join(''),
    spans: tagged.spans,
    misaligned: tagged.misaligned,
  };
}

async function* writeConll({ schema }: ExportContext, tasks: AsyncIterable<ExportTask>) {
  for await (const task of tasks) {
    const block = conllBlock(schema, task);
    // an empty line ends a task
    if (block) yield `${block.text}\n`;
  }
}

// Zip formats for boxes -----------------------------------------------------

/** The file name at the end of an image address: `street-1.jpg` for `https://host/a/street-1.jpg?x=1`. */
export function imageFileName(image: string): string {
  let path = image;
  if (/^https?:\/\//i.test(image)) {
    try {
      path = new URL(image).pathname;
    } catch {
      return '';
    }
  }
  const last = path.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * A file name for a task inside an archive, without an extension: from the
 * image's own file name, or else the external id, or else the task id. Only
 * letters, digits, dot, dash and underscore are kept, so no name has a folder
 * in it or climbs out of one.
 */
export function entryBaseName(task: ExportTask, imageField: string): string {
  const clean = (raw: string) =>
    raw
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._-]+|[._-]+$/g, '')
      .slice(0, 80);
  const image = imageFileName(String(task.data[imageField] ?? ''));
  return (
    clean(image.replace(/\.[A-Za-z0-9]{1,5}$/, '')) ||
    clean(task.externalId ?? '') ||
    clean(task.id) ||
    'task'
  );
}

/** Hands out each name once. A second task with a name gets `-2`, a third `-3`. */
export class UniqueNames {
  private readonly used = new Map<string, number>();

  take(base: string): string {
    // file systems that ignore case would unpack `Cat` over `cat`
    const key = base.toLowerCase();
    const count = (this.used.get(key) ?? 0) + 1;
    this.used.set(key, count);
    if (count === 1) return base;
    return this.take(`${base}-${count}`);
  }
}

const round6 = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** YOLO label lines: class index, then centre and size as shares of the image. */
export function yoloLabels(labels: string[], answer: BboxAnswer): string {
  const lines: string[] = [];
  for (const box of answer.boxes) {
    const index = labels.indexOf(box.label);
    if (index < 0 || !(answer.imageWidth > 0) || !(answer.imageHeight > 0)) continue;
    lines.push(
      [
        index,
        round6((box.x + box.w / 2) / answer.imageWidth),
        round6((box.y + box.h / 2) / answer.imageHeight),
        round6(box.w / answer.imageWidth),
        round6(box.h / answer.imageHeight),
      ].join(' '),
    );
  }
  return lines.map((line) => `${line}\n`).join('');
}

/** Control characters that XML 1.0 does not allow at all: everything below a space but tab, LF and CR. */
function allowedInXml(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function xml(text: string): string {
  return [...text]
    .filter(allowedInXml)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One Pascal VOC annotation file. Corners are whole pixels, counted from 0. */
export function vocXml(fileName: string, image: string, answer: BboxAnswer): string {
  const objects = answer.boxes
    .map(
      (box) =>
        `  <object>\n    <name>${xml(box.label)}</name>\n    <pose>Unspecified</pose>\n` +
        `    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <bndbox>\n` +
        `      <xmin>${Math.round(box.x)}</xmin>\n      <ymin>${Math.round(box.y)}</ymin>\n` +
        `      <xmax>${Math.round(box.x + box.w)}</xmax>\n      <ymax>${Math.round(box.y + box.h)}</ymax>\n` +
        `    </bndbox>\n  </object>\n`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<annotation>\n  <filename>${xml(fileName)}</filename>\n` +
    `  <path>${xml(image)}</path>\n  <size>\n    <width>${Math.round(answer.imageWidth)}</width>\n` +
    `    <height>${Math.round(answer.imageHeight)}</height>\n    <depth>3</depth>\n  </size>\n` +
    `  <segmented>0</segmented>\n${objects}</annotation>\n`
  );
}

const MANIFEST_HEADER = ['file', 'task_id', 'external_id', 'image', 'width', 'height', 'boxes'];

/**
 * A zip with one file per labeled task, a list of the classes and a manifest
 * that says which file belongs to which task and image. The images are not in
 * it: the portal only knows their addresses and never fetches them.
 */
async function* writeBoxArchive(
  context: ExportContext,
  tasks: AsyncIterable<ExportTask>,
  folder: string,
  extension: string,
  render: (name: string, image: string, answer: BboxAnswer, labels: string[]) => string,
) {
  const schema = boxSchema(context.schema, folder === 'labels' ? 'YOLO' : 'Pascal VOC');
  const zip = new ZipWriter(context.now);
  const names = new UniqueNames();
  const manifest = [toCsvLine(MANIFEST_HEADER)];
  yield zip.add('classes.txt', schema.labels.map((label) => `${label}\n`).join(''));
  for await (const task of tasks) {
    const answer = finalLabel(task) as BboxAnswer | null;
    const image = String(task.data[schema.imageField] ?? '');
    let file = '';
    if (answer) {
      const name = names.take(entryBaseName(task, schema.imageField));
      file = `${folder}/${name}.${extension}`;
      // the writer refuses a name that could leave the folder it is unpacked in
      yield zip.add(file, render(name, image, answer, schema.labels));
    }
    manifest.push(
      toCsvLine([
        file,
        task.id,
        task.externalId,
        image,
        answer?.imageWidth ?? null,
        answer?.imageHeight ?? null,
        answer ? answer.boxes.length : null,
      ]),
    );
  }
  yield zip.add('manifest.csv', manifest.join(''));
  yield zip.finish();
}

const writeYolo: Writer = (context, tasks) =>
  writeBoxArchive(context, tasks, 'labels', 'txt', (_name, _image, answer, labels) =>
    yoloLabels(labels, answer),
  );

const writeVoc: Writer = (context, tasks) =>
  writeBoxArchive(context, tasks, 'annotations', 'xml', (name, image, answer) => {
    const extension = imageFileName(image).match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? '';
    return vocXml(`${name}${extension}`, image, answer);
  });

// The table -------------------------------------------------------------------

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  {
    name: 'jsonl',
    label: 'JSON Lines',
    hint: 'One task per line with every accepted annotation. Can be imported again.',
    contentType: 'application/x-ndjson; charset=utf-8',
    extension: 'jsonl',
    needs: 'annotations',
    write: writeJsonl,
  },
  {
    name: 'csv',
    label: 'CSV',
    hint: 'One row per annotation, plus a consensus row. Can be imported again.',
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
    needs: 'annotations',
    write: writeCsv,
  },
  {
    name: 'coco',
    label: 'COCO',
    hint: 'Object detection dataset from the consensus boxes.',
    kinds: ['bbox'],
    contentType: 'application/json; charset=utf-8',
    extension: 'coco.json',
    needs: 'labels',
    write: writeCoco,
  },
  {
    name: 'yolo',
    label: 'YOLO',
    hint: 'A zip with one label file per image, classes.txt and a manifest.',
    kinds: ['bbox'],
    contentType: 'application/zip',
    extension: 'yolo.zip',
    needs: 'labels',
    archive: true,
    write: writeYolo,
  },
  {
    name: 'voc',
    label: 'Pascal VOC',
    hint: 'A zip with one XML file per image and a manifest.',
    kinds: ['bbox'],
    contentType: 'application/zip',
    extension: 'voc.zip',
    needs: 'labels',
    archive: true,
    write: writeVoc,
  },
  {
    name: 'conll',
    label: 'CoNLL (BIO tags)',
    hint: 'One token and its tag per line, from the consensus spans.',
    kinds: ['ner'],
    contentType: 'text/plain; charset=utf-8',
    extension: 'conll',
    needs: 'labels',
    write: writeConll,
  },
];

/** The formats a project of this kind can be exported in, in the order the page lists them. */
export function exportFormatsFor(kind: SchemaKind): ExportFormat[] {
  return EXPORT_FORMATS.filter((format) => !format.kinds || format.kinds.includes(kind));
}

export function findExportFormat(name: string): ExportFormat | null {
  return EXPORT_FORMATS.find((format) => format.name === name) ?? null;
}
