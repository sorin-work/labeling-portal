import { requiredFields, type TaskSchema } from '~/domain/task-schema';

const HIDDEN = new Set(['id', 'width', 'height']);

/** Extra columns from the import (source, url, language, ...) shown as context. */
export function TaskContext({
  schema,
  data,
}: {
  schema: TaskSchema;
  data: Record<string, unknown>;
}) {
  const used = new Set(requiredFields(schema));
  const extra = Object.entries(data).filter(
    ([key, value]) => !used.has(key) && !HIDDEN.has(key) && value !== '',
  );
  if (extra.length === 0) return null;
  return (
    <details className="rounded-md bg-slate-50 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-slate-600">Context ({extra.length})</summary>
      <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {extra.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="font-mono text-xs text-slate-500">{key}</dt>
            <dd className="break-words">
              {typeof value === 'string' ? value : JSON.stringify(value)}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
