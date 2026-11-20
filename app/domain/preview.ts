import { mainField, type TaskSchema } from './task-schema';

/** A one-line summary of a task for lists. */
export function taskPreview(schema: TaskSchema, data: unknown, max = 90): string {
  const record = (data ?? {}) as Record<string, unknown>;
  const raw = record[mainField(schema)];
  const text = (typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
