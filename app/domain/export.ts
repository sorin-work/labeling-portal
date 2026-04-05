import type {
  Answer,
  BboxAnswer,
  ClassificationAnswer,
  NerAnswer,
  PairwiseAnswer,
} from './answers';
import { toCsv } from './csv';
import { spanText } from './spans';
import type { TaskSchema } from './task-schema';

export type ExportAnnotation = {
  annotator: string;
  answer: Answer;
  reviewStatus: string | null;
  qaScore: number | null;
  activeSeconds: number;
  submittedAt: string | null;
};

export type ExportTask = {
  id: string;
  externalId: string | null;
  batch: string;
  data: Record<string, unknown>;
  status: string;
  consensus: Answer | null;
  agreement: number | null;
  annotations: ExportAnnotation[];
};

/** Adds the covered text to each span so exports are readable on their own. */
function withSpanText(schema: TaskSchema, data: Record<string, unknown>, answer: Answer | null) {
  if (!answer || schema.kind !== 'ner') return answer;
  const text = String(data[schema.textField] ?? '');
  return {
    spans: (answer as NerAnswer).spans.map((s) => ({ ...s, text: spanText(text, s) })),
  };
}

/** One JSON object per task with every accepted annotation and the consensus. */
export function toJsonl(schema: TaskSchema, tasks: ExportTask[]): string {
  return tasks
    .map((task) =>
      JSON.stringify({
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
      }),
    )
    .map((line) => `${line}\n`)
    .join('');
}

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

function answerCells(schema: TaskSchema, data: Record<string, unknown>, answer: Answer | null) {
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

/** One row per accepted annotation; consensus rows use "consensus" as the annotator. */
export function toCsvExport(schema: TaskSchema, tasks: ExportTask[]): string {
  const header = [
    'task_id',
    'external_id',
    'batch',
    'annotator',
    'review_status',
    'qa_score',
    'active_seconds',
    ...answerColumns(schema),
  ];
  const rows: Array<Array<string | number | null>> = [];
  for (const task of tasks) {
    for (const a of task.annotations) {
      rows.push([
        task.id,
        task.externalId,
        task.batch,
        a.annotator,
        a.reviewStatus?.toLowerCase() ?? '',
        a.qaScore,
        a.activeSeconds,
        ...answerCells(schema, task.data, a.answer),
      ]);
    }
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
      ]);
    }
  }
  return toCsv(header, rows);
}

export type CocoDataset = {
  info: { description: string; date_created: string };
  images: Array<{ id: number; file_name: string; width: number; height: number; task_id: string }>;
  categories: Array<{ id: number; name: string }>;
  annotations: Array<{
    id: number;
    image_id: number;
    category_id: number;
    bbox: [number, number, number, number];
    area: number;
    iscrowd: 0;
  }>;
};

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
  if (schema.kind !== 'bbox') throw new Error('COCO export is only available for box projects');
  const categories = schema.labels.map((name, i) => ({ id: i + 1, name }));
  const categoryId = new Map(categories.map((c) => [c.name, c.id]));
  const dataset: CocoDataset = {
    info: { description, date_created: now.toISOString() },
    images: [],
    categories,
    annotations: [],
  };

  tasks.forEach((task, index) => {
    const answer = (task.consensus ??
      (task.annotations.length === 1 ? task.annotations[0].answer : null)) as BboxAnswer | null;
    const imageId = index + 1;
    dataset.images.push({
      id: imageId,
      file_name: String(task.data[schema.imageField] ?? ''),
      width: answer?.imageWidth ?? Number(task.data.width ?? 0),
      height: answer?.imageHeight ?? Number(task.data.height ?? 0),
      task_id: task.id,
    });
    for (const box of answer?.boxes ?? []) {
      const category = categoryId.get(box.label);
      if (!category) continue;
      dataset.annotations.push({
        id: dataset.annotations.length + 1,
        image_id: imageId,
        category_id: category,
        bbox: [box.x, box.y, box.w, box.h],
        area: Math.round(box.w * box.h * 10) / 10,
        iscrowd: 0,
      });
    }
  });
  return dataset;
}
