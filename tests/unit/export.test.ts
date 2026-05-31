import { describe, expect, it } from 'vitest';

import { toCoco, toCsvExport, toJsonl, type ExportTask } from '~/domain/export';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

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
    const [header, row] = toCsvExport(SCHEMA_TEMPLATES.pairwise, [task]).split('\r\n');
    expect(header).toBe(
      'task_id,external_id,batch,annotator,review_status,qa_score,active_seconds,preference,a_helpfulness,b_helpfulness,a_accuracy,b_accuracy,a_safety,b_safety,rationale',
    );
    expect(row).toBe(
      't1,ext-1,March,ann@example.test,fixed,3,90,A,5,2,4,3,5,5,"A is right, ""B"" is vague"',
    );
  });

  it('adds a consensus row for classification', () => {
    const task: ExportTask = {
      ...base,
      data: { text: 'x' },
      consensus: { labels: ['neutral'] },
      annotations: [],
    };
    const lines = toCsvExport(SCHEMA_TEMPLATES.text_classification, [task]).trimEnd().split('\r\n');
    expect(lines[1]).toBe('t1,ext-1,March,consensus,,,,neutral');
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
