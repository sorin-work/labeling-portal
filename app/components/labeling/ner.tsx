import { useRef } from 'react';

import type { NerAnswer } from '~/domain/answers';
import { addSpan, removeSpan, segmentText, spanText, trimSelection } from '~/domain/spans';
import type { NerSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useHotkeys } from './use-hotkeys';
import { useRemembered } from './use-remembered';

const FALLBACK_COLORS = ['#f59e0b', '#6366f1', '#10b981', '#ef4444', '#0ea5e9', '#a855f7'];

function colorFor(schema: NerSchema, label: string): string {
  const index = schema.entities.findIndex((e) => e.name === label);
  return schema.entities[index]?.color ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

/** Offset of a DOM position inside the text, using the data-start of its segment. */
function offsetOf(node: Node, offset: number): number | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const segment = element?.closest<HTMLElement>('[data-start]');
  if (!segment) return null;
  return Number(segment.dataset.start) + (node.nodeType === Node.TEXT_NODE ? offset : 0);
}

export function NerSpans({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<NerSchema, NerAnswer>) {
  const text = String(data[schema.textField] ?? '');
  const spans = value?.spans ?? [];
  const [active, setActive] = useRemembered(
    'labeling-portal:entity',
    schema.entities[0]?.name ?? '',
    schema.entities.map((e) => e.name),
  );
  const container = useRef<HTMLDivElement>(null);

  useHotkeys((key) => {
    const index = Number(key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= Math.min(9, schema.entities.length)) {
      return false;
    }
    setActive(schema.entities[index].name);
    return true;
  }, !readOnly);

  const onMouseUp = () => {
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !container.current) return;
    const range = selection.getRangeAt(0);
    if (!container.current.contains(range.commonAncestorContainer)) return;
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    selection.removeAllRanges();
    if (a === null || b === null) return;
    const [start, end] = trimSelection(text, a, b);
    if (start >= end) return;
    onChange({ spans: addSpan(spans, { start, end, label: active }) });
  };

  return (
    <div className="space-y-4">
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Entity type
          </span>
          {schema.entities.map((entity, index) => (
            <button
              key={entity.name}
              type="button"
              onClick={() => setActive(entity.name)}
              aria-pressed={active === entity.name}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ring-1',
                active === entity.name ? 'ring-2 ring-slate-800' : 'ring-slate-300',
              )}
            >
              <span
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: colorFor(schema, entity.name) }}
              />
              {index < 9 && <kbd className="font-mono text-xs text-slate-400">{index + 1}</kbd>}
              {entity.name}
            </button>
          ))}
        </div>
      )}
      <div
        ref={container}
        onMouseUp={onMouseUp}
        className="whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-base leading-8"
      >
        {segmentText(text, spans).map((segment) =>
          segment.span ? (
            <mark
              key={segment.start}
              data-start={segment.start}
              onClick={() => !readOnly && onChange({ spans: removeSpan(spans, segment) })}
              title={readOnly ? segment.span.label : `${segment.span.label} (click to remove)`}
              className={cx('rounded px-0.5 text-slate-900', !readOnly && 'cursor-pointer')}
              style={{ backgroundColor: `${colorFor(schema, segment.span.label)}55` }}
            >
              {segment.text}
              <sup className="ml-0.5 select-none text-[10px] font-semibold uppercase text-slate-600">
                {segment.span.label}
              </sup>
            </mark>
          ) : (
            <span key={segment.start} data-start={segment.start}>
              {segment.text}
            </span>
          ),
        )}
      </div>
      {spans.length === 0 ? (
        <p className="text-sm text-slate-500">
          {readOnly
            ? 'No entities were marked.'
            : 'Select text with the mouse to mark it. Submit with no spans if nothing applies.'}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {spans.map((span) => (
            <li
              key={`${span.start}-${span.end}`}
              className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"
            >
              <span className="font-medium">{span.label}</span>{' '}
              <span className="text-slate-600">“{spanText(text, span)}”</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
