import { useId } from 'react';

import type { ClassificationAnswer } from '~/domain/answers';
import { labelKeys } from '~/domain/hotkeys';
import type { TextClassificationSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useInterfaceHotkeys } from './use-hotkeys';

export function TextClassification({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<TextClassificationSchema, ClassificationAnswer>) {
  const selected = value?.labels ?? [];
  const text = String(data[schema.textField] ?? '');
  const name = useId();

  const toggle = (label: string) => {
    if (readOnly) return;
    if (!schema.multiple) return onChange({ labels: [label] });
    const next = selected.includes(label)
      ? selected.filter((l) => l !== label)
      : [...selected, label];
    onChange({ labels: next });
  };

  const keys = labelKeys(schema.labels.length);
  const inUse = useInterfaceHotkeys(schema, readOnly, (hit) => {
    if (hit.action !== 'label') return false;
    toggle(schema.labels[hit.index]);
    return true;
  });

  return (
    <div className="space-y-5" {...inUse}>
      <p className="whitespace-pre-wrap text-base leading-7">{text}</p>
      <fieldset>
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
          {schema.multiple ? 'Pick every label that applies' : 'Pick one label'}
          {!readOnly && <span className="ml-2 normal-case text-slate-500">(or press its key)</span>}
        </legend>
        {/* Real radio buttons and checkboxes: one tab stop for a radio group,
            the arrow keys choose, Space ticks a checkbox. */}
        <div className="flex flex-wrap gap-2">
          {schema.labels.map((label, index) => {
            const active = selected.includes(label);
            return (
              <label key={label} className="relative">
                <input
                  type={schema.multiple ? 'checkbox' : 'radio'}
                  name={name}
                  value={label}
                  checked={active}
                  disabled={readOnly}
                  onChange={() => toggle(label)}
                  className="peer sr-only"
                />
                <span
                  className={cx(
                    'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium ring-1 transition-colors',
                    'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-600',
                    active
                      ? 'bg-indigo-600 text-white ring-indigo-600'
                      : 'bg-white text-slate-700 ring-slate-300',
                    !readOnly && 'cursor-pointer',
                    !readOnly && !active && 'hover:bg-slate-50',
                  )}
                >
                  {keys[index] && !readOnly && (
                    <kbd
                      className={cx(
                        'mr-1.5 font-mono text-xs',
                        active ? 'text-indigo-100' : 'text-slate-500',
                      )}
                    >
                      {keys[index]}
                    </kbd>
                  )}
                  {label}
                  {/* chosen is told by a mark as well, not by the colour alone */}
                  {active && (
                    <span aria-hidden className="ml-1.5">
                      ✓
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
