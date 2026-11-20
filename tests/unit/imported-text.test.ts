import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LabelingInterface } from '~/components/labeling';
import { TaskContext } from '~/components/task-context';
import { readImportFile } from '~/domain/import';
import { SCHEMA_TEMPLATES, type TaskSchema } from '~/domain/task-schema';

/**
 * Imported text is data. This renders the components that show a task with
 * markup in every field, the way the server renders them for the page, and
 * looks for an element that the import brought in.
 */
const MARKUP = '<img src=x onerror=alert(1)><script>alert(2)</script><b>bold</b>';

function rendered(schema: TaskSchema, data: Record<string, unknown>): string {
  return (
    renderToString(
      createElement(LabelingInterface, { schema, data, value: null, onChange: () => {} }),
    ) + renderToString(createElement(TaskContext, { schema, data }))
  );
}

function expectNoImportedMarkup(html: string) {
  // nothing of it became an element
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<b>bold');
  expect(html).not.toMatch(/<img[^>]*onerror/);
  // it is on the page as the text it is
  expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
}

describe('imported text on the page', () => {
  const cases: Array<[string, TaskSchema, Record<string, unknown>]> = [
    ['text classification', SCHEMA_TEMPLATES.text_classification, { text: MARKUP }],
    ['named entities', SCHEMA_TEMPLATES.ner, { text: MARKUP }],
    [
      'pairwise',
      SCHEMA_TEMPLATES.pairwise,
      { prompt: MARKUP, response_a: MARKUP, response_b: MARKUP },
    ],
  ];

  it.each(cases)('is shown as text in a %s task', (_name, schema, data) => {
    const html = rendered(schema, { ...data, note: MARKUP, nested: { also: MARKUP } });
    expectNoImportedMarkup(html);
  });

  it('is shown as text when it came in through an import', () => {
    const file = new TextEncoder().encode(JSON.stringify([{ text: MARKUP, source: MARKUP }]));
    const result = readImportFile(file, 'tasks.json', SCHEMA_TEMPLATES.text_classification);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // stored as it was written, not cleaned: it is the display that keeps it text
    expect(result.rows[0].data).toEqual({ text: MARKUP, source: MARKUP });
    expectNoImportedMarkup(rendered(SCHEMA_TEMPLATES.text_classification, result.rows[0].data));
  });

  it('puts an image address into the src attribute and nowhere else', () => {
    const html = rendered(SCHEMA_TEMPLATES.bbox, {
      image_url: 'https://cdn.example.test/a.jpg?x="><script>alert(3)</script>',
      note: MARKUP,
    });
    expect(html).not.toContain('<script');
    expect(html).toContain('src="https://cdn.example.test/a.jpg?x=&quot;&gt;&lt;script&gt;');
  });
});
