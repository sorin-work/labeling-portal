import { toCsv } from './csv';
import type { TaskSchema } from './task-schema';

/** Two example rows (one of them gold) showing the fields a project expects. */
export function sampleRows(schema: TaskSchema): Array<Record<string, unknown>> {
  switch (schema.kind) {
    case 'text_classification':
      return [
        { id: 'example-1', [schema.textField]: 'Replace this with the text to classify.' },
        {
          id: 'gold-1',
          [schema.textField]: 'A gold task: annotators are scored against _gold.',
          _gold: schema.labels[0],
        },
      ];
    case 'ner':
      return [
        {
          id: 'example-1',
          [schema.textField]: 'Ada Lovelace worked with Charles Babbage in London.',
        },
        {
          id: 'gold-1',
          [schema.textField]: 'Grace Hopper joined the Navy.',
          _gold: { spans: [{ start: 0, end: 12, label: schema.entities[0].name }] },
        },
      ];
    case 'pairwise':
      return [
        {
          id: 'example-1',
          [schema.promptField]: 'The user prompt',
          [schema.responseAField]: 'First response',
          [schema.responseBField]: 'Second response',
        },
        {
          id: 'gold-1',
          [schema.promptField]: 'What is 2 + 2?',
          [schema.responseAField]: '4',
          [schema.responseBField]: '5',
          _gold: 'A',
        },
      ];
    case 'bbox':
      return [
        {
          id: 'example-1',
          [schema.imageField]: 'https://example.com/image-1.jpg',
          width: 640,
          height: 480,
        },
        {
          id: 'gold-1',
          [schema.imageField]: 'https://example.com/image-2.jpg',
          width: 640,
          height: 480,
          _gold: { boxes: [{ x: 10, y: 20, w: 100, h: 80, label: schema.labels[0] }] },
        },
      ];
  }
}

export function sampleFile(schema: TaskSchema, format: 'csv' | 'jsonl'): string {
  const rows = sampleRows(schema);
  if (format === 'jsonl') return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return toCsv(
    header,
    rows.map((r) =>
      header.map((h) => {
        const v = r[h];
        return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      }),
    ),
  );
}
