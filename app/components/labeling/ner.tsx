import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { NerAnswer, Span } from '~/domain/answers';
import { interfaceShortcut, isTextEntry, labelKeys } from '~/domain/hotkeys';
import { ENTITY_COLORS, ENTITY_TINT } from '~/domain/palette';
import {
  addSpan,
  cursorRange,
  moveCursor,
  relabelSpan,
  removeSpan,
  segmentText,
  spanText,
  splitAtRange,
  trimSelection,
  wordAt,
  wordRanges,
  type WordCursor,
} from '~/domain/spans';
import type { NerSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { focusTarget, useInterfaceHotkeys } from './use-hotkeys';
import { useRemembered } from './use-remembered';

function colorFor(schema: NerSchema, label: string): string {
  const index = schema.entities.findIndex((e) => e.name === label);
  return schema.entities[index]?.color ?? ENTITY_COLORS[index % ENTITY_COLORS.length];
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
  // A click picks a span. Its type can then be changed and it can be removed,
  // as with a selected box.
  const [picked, setPicked] = useState<Pick<Span, 'start' | 'end'> | null>(null);
  const same = (a: Pick<Span, 'start' | 'end'>, b: Pick<Span, 'start' | 'end'> | null) =>
    b !== null && a.start === b.start && a.end === b.end;
  const selected = spans.find((span) => same(span, picked)) ?? null;
  const keys = labelKeys(schema.entities.length);

  // The keyboard path: while the text has focus a cursor walks it word by
  // word, Shift extends it, and Enter marks the selected words with the
  // active type. What happens is said in a live region.
  const words = useMemo(() => wordRanges(text), [text]);
  const [cursor, setCursor] = useState<WordCursor | null>(null);
  const [textFocused, setTextFocused] = useState(false);
  const selection = cursor ? cursorRange(words, cursor) : null;
  const [said, setSaid] = useState('');
  const hintId = useId();
  const textHasFocus = () =>
    container.current !== null && document.activeElement === container.current;

  // The span that was removed last can be put back once, until anything else
  // changes. (The box interface gets a full undo; this covers the slip.)
  const [removed, setRemoved] = useState<{ span: Span; from: Span[] } | null>(null);
  const undoable = removed !== null && removed.from === spans ? removed.span : null;

  const remove = (target: Pick<Span, 'start' | 'end'>) => {
    const span = spans.find((s) => same(s, target));
    if (!span) return;
    const next = removeSpan(spans, span);
    setRemoved({ span, from: next });
    onChange({ spans: next });
    if (same(span, picked)) setPicked(null);
    setSaid(`Removed ${span.label} “${spanText(text, span)}”.`);
  };
  const putBack = () => {
    if (!undoable) return false;
    setRemoved(null);
    onChange({ spans: addSpan(spans, undoable) });
    setPicked(undoable);
    setSaid(`Put back ${undoable.label} “${spanText(text, undoable)}”.`);
    return true;
  };

  // A picked span is let go when the cursor goes into a text box, so that a
  // key meant for the text (a reviewer writing feedback) cannot hit the span.
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      if (isTextEntry(focusTarget(event.target))) setPicked(null);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  const step = (by: number, extend: boolean) => {
    if (!textHasFocus() || words.length === 0) return false;
    const next = moveCursor(words, cursor ?? { anchor: 0, focus: 0 }, cursor ? by : 0, extend);
    setCursor(next);
    const range = cursorRange(words, next);
    if (range) setSaid(spanText(text, range));
    return true;
  };

  const mark = () => {
    if (!textHasFocus() || !selection) return false;
    onChange({ spans: addSpan(spans, { ...selection, label: active }) });
    setPicked(null);
    setCursor((c) => (c ? { anchor: c.focus, focus: c.focus } : c));
    setSaid(`Marked ${active} “${spanText(text, selection)}”.`);
    return true;
  };

  const inUse = useInterfaceHotkeys(schema, readOnly, (hit) => {
    if (hit.action === 'cursor') return step(hit.index === 0 ? -1 : 1, false);
    if (hit.action === 'extend') return step(hit.index === 0 ? -1 : 1, true);
    if (hit.action === 'mark') return mark();
    if (hit.action === 'undoRemove') return putBack();
    if (hit.action === 'remove') {
      if (!selected) return false;
      remove(selected);
      return true;
    }
    if (hit.action === 'label') {
      const { name } = schema.entities[hit.index];
      if (selected) onChange({ spans: relabelSpan(spans, selected, name) });
      else setActive(name);
      return true;
    }
    return false;
  });

  const onMouseUp = (event: React.MouseEvent) => {
    if (readOnly) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      // a plain click next to the spans lets go of the picked one
      if (!(event.target as Element).closest('mark')) setPicked(null);
      return;
    }
    if (!container.current) return;
    const range = selection.getRangeAt(0);
    if (!container.current.contains(range.commonAncestorContainer)) return;
    const a = offsetOf(range.startContainer, range.startOffset);
    const b = offsetOf(range.endContainer, range.endOffset);
    selection.removeAllRanges();
    if (a === null || b === null) return;
    const [start, end] = trimSelection(text, a, b);
    if (start >= end) return;
    onChange({ spans: addSpan(spans, { start, end, label: active }) });
    setPicked(null);
    setSaid(`Marked ${active} “${text.slice(start, end)}”.`);
  };

  const keyHint = `With the keyboard: Tab to the text, ${interfaceShortcut(schema, ['cursor'])} go from word to word, ${interfaceShortcut(schema, ['extend'])} select more, ${interfaceShortcut(schema, ['mark'])} marks the selection as the entity type.`;

  return (
    <div className="space-y-4" {...inUse}>
      <p role="status" className="sr-only">
        {said}
      </p>
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
              {keys[index] && <kbd className="font-mono text-xs text-slate-500">{keys[index]}</kbd>}
              {entity.name}
            </button>
          ))}
        </div>
      )}
      <div
        ref={container}
        onMouseUp={onMouseUp}
        role={readOnly ? undefined : 'group'}
        aria-label={readOnly ? undefined : 'Text to label'}
        aria-describedby={readOnly ? undefined : hintId}
        tabIndex={readOnly ? undefined : 0}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          setTextFocused(true);
          // the cursor starts on the first word, or where it was
          if (!cursor && words.length > 0) {
            const at = wordAt(words, picked?.start ?? 0);
            setCursor({ anchor: at, focus: at });
            setSaid(spanText(text, words[at]));
          }
        }}
        onBlur={() => setTextFocused(false)}
        className="whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-base leading-8"
      >
        {splitAtRange(segmentText(text, spans), textFocused ? selection : null).map((segment) =>
          segment.span ? (
            <mark
              key={segment.start}
              data-start={segment.start}
              onClick={() => !readOnly && setPicked(same(segment, picked) ? null : segment)}
              title={readOnly ? segment.span.label : `${segment.span.label} (click to select)`}
              className={cx(
                'rounded px-0.5 text-slate-900',
                !readOnly && 'cursor-pointer',
                same(segment, picked) && 'ring-2 ring-slate-800',
                segment.inRange && 'outline-2 outline-offset-1 outline-indigo-600',
              )}
              style={{ backgroundColor: `${colorFor(schema, segment.span.label)}${ENTITY_TINT}` }}
            >
              {segment.text}
              <sup className="ml-0.5 select-none text-[10px] font-semibold uppercase text-slate-600">
                {segment.span.label}
              </sup>
            </mark>
          ) : (
            <span
              key={segment.start}
              data-start={segment.start}
              className={cx(
                segment.inRange && 'rounded-sm bg-indigo-100 outline-2 outline-indigo-600',
              )}
            >
              {segment.text}
            </span>
          ),
        )}
      </div>
      {!readOnly && (
        <p id={hintId} className="text-xs text-slate-500">
          {keyHint}
        </p>
      )}
      {!readOnly && undoable && (
        <p className="flex items-center gap-2 text-sm text-slate-600">
          Removed {undoable.label} “{spanText(text, undoable)}”.
          <button
            type="button"
            className="font-medium text-indigo-700 hover:underline"
            title={`Shortcut: ${interfaceShortcut(schema, ['undoRemove'])}`}
            onClick={putBack}
          >
            Undo
          </button>
        </p>
      )}
      {spans.length === 0 ? (
        <p className="text-sm text-slate-500">
          {readOnly
            ? 'No entities were marked.'
            : 'Select text with the mouse to mark it, or with the keyboard (see below). Submit with no spans if nothing applies.'}
        </p>
      ) : (
        <>
          {!readOnly && (
            <p className="text-sm text-slate-500">
              {selected
                ? 'Span selected: press the key of a type to change it, or Delete to remove it.'
                : 'Click a span to select it.'}
            </p>
          )}
          <ul className="flex flex-wrap gap-2 text-sm">
            {spans.map((span) => (
              <li
                key={`${span.start}-${span.end}`}
                className={cx(
                  'flex items-center gap-2 rounded-md bg-white px-2 py-1 ring-1',
                  same(span, picked) ? 'ring-2 ring-slate-800' : 'ring-slate-200',
                )}
              >
                <button
                  type="button"
                  disabled={readOnly}
                  aria-pressed={readOnly ? undefined : same(span, picked)}
                  onClick={() => setPicked(same(span, picked) ? null : span)}
                >
                  <span className="font-medium">{span.label}</span>{' '}
                  <span className="text-slate-600">“{spanText(text, span)}”</span>
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Remove ${span.label} “${spanText(text, span)}”`}
                    onClick={() => remove(span)}
                    className="text-slate-500 hover:text-rose-700"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
