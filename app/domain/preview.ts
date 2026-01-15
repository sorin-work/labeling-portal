import type { TaskSchema } from './task-schema';

/** A one-line summary of a task for lists. */
export function taskPreview(schema: TaskSchema, data: unknown, max = 90): string {
  const record = (data ?? {}) as Record<string, unknown>;
  const field =
    schema.kind === 'pairwise'
      ? schema.promptField
      : schema.kind === 'bbox'
        ? schema.imageField
        : schema.textField;
  const raw = record[field];
  const text = (typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
