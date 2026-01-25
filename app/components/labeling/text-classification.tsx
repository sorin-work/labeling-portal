import type { ClassificationAnswer } from '~/domain/answers';
import type { TextClassificationSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useHotkeys } from './use-hotkeys';

export function TextClassification({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<TextClassificationSchema, ClassificationAnswer>) {
  const selected = value?.labels ?? [];
  const text = String(data[schema.textField] ?? '');

  const toggle = (label: string) => {
    if (readOnly) return;
    if (!schema.multiple) return onChange({ labels: [label] });
    const next = selected.includes(label)
      ? selected.filter((l) => l !== label)
      : [...selected, label];
    onChange({ labels: next });
  };

  useHotkeys((key) => {
    const index = Number(key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= Math.min(9, schema.labels.length)) {
      return false;
    }
    toggle(schema.labels[index]);
    return true;
  }, !readOnly);

  return (
    <div className="space-y-5">
      <p className="whitespace-pre-wrap text-base leading-7">{text}</p>
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          {schema.multiple ? 'Pick every label that applies' : 'Pick one label'}
          {!readOnly && (
            <span className="ml-2 normal-case text-slate-400">(number keys work too)</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2" role={schema.multiple ? 'group' : 'radiogroup'}>
          {schema.labels.map((label, index) => {
            const active = selected.includes(label);
            return (
              <button
                key={label}
                type="button"
                role={schema.multiple ? 'checkbox' : 'radio'}
                aria-checked={active}
                disabled={readOnly}
                onClick={() => toggle(label)}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm font-medium ring-1 transition-colors',
                  active
                    ? 'bg-indigo-600 text-white ring-indigo-600'
                    : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50',
                )}
              >
                {index < 9 && !readOnly && (
                  <kbd
                    className={cx(
                      'mr-1.5 font-mono text-xs',
                      active ? 'text-indigo-200' : 'text-slate-400',
                    )}
                  >
                    {index + 1}
                  </kbd>
                )}
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
