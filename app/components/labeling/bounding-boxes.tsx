import { useRef, useState, type PointerEvent } from 'react';

import type { BboxAnswer, Box } from '~/domain/answers';
import type { BboxSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { useHotkeys } from './use-hotkeys';

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899'];

type Point = { x: number; y: number };

export function BoundingBoxes({
  schema,
  data,
  value,
  onChange,
  readOnly,
}: LabelingProps<BboxSchema, BboxAnswer>) {
  const src = String(data[schema.imageField] ?? '');
  const imageRef = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(
    value ? { w: value.imageWidth, h: value.imageHeight } : null,
  );
  const [active, setActive] = useState(schema.labels[0]);
  const [start, setStart] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const boxes = value?.boxes ?? [];

  const colorOf = (label: string) => COLORS[schema.labels.indexOf(label) % COLORS.length];

  const emit = (next: Box[]) => {
    if (!size) return;
    onChange({ boxes: next, imageWidth: size.w, imageHeight: size.h });
  };

  /** Pointer position in image pixels. */
  const toImage = (event: PointerEvent<SVGSVGElement>): Point | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!size || rect.width === 0) return null;
    const scale = size.w / rect.width;
    return {
      x: Math.min(size.w, Math.max(0, (event.clientX - rect.left) * scale)),
      y: Math.min(size.h, Math.max(0, (event.clientY - rect.top) * scale)),
    };
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (readOnly || event.target !== event.currentTarget) return;
    const p = toImage(event);
    if (!p) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected(null);
    setStart(p);
    setCursor(p);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (start) setCursor(toImage(event));
  };

  const onPointerUp = () => {
    if (start && cursor) {
      const box: Box = {
        x: Math.min(start.x, cursor.x),
        y: Math.min(start.y, cursor.y),
        w: Math.abs(cursor.x - start.x),
        h: Math.abs(cursor.y - start.y),
        label: active,
      };
      if (box.w >= schema.minBoxSize && box.h >= schema.minBoxSize) {
        emit([...boxes, box]);
        setSelected(boxes.length);
      }
    }
    setStart(null);
    setCursor(null);
  };

  useHotkeys((key) => {
    if ((key === 'Delete' || key === 'Backspace') && selected !== null) {
      emit(boxes.filter((_, i) => i !== selected));
      setSelected(null);
      return true;
    }
    const index = Number(key) - 1;
    if (Number.isInteger(index) && index >= 0 && index < Math.min(9, schema.labels.length)) {
      const label = schema.labels[index];
      if (selected !== null) emit(boxes.map((b, i) => (i === selected ? { ...b, label } : b)));
      else setActive(label);
      return true;
    }
    return false;
  }, !readOnly);

  const preview =
    start && cursor
      ? {
          x: Math.min(start.x, cursor.x),
          y: Math.min(start.y, cursor.y),
          w: Math.abs(cursor.x - start.x),
          h: Math.abs(cursor.y - start.y),
        }
      : null;
  const stroke = size ? Math.max(1, size.w / 400) : 1;

  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Label</span>
          {schema.labels.map((label, index) => (
            <button
              key={label}
              type="button"
              aria-pressed={active === label}
              onClick={() => setActive(label)}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ring-1',
                active === label ? 'ring-2 ring-slate-800' : 'ring-slate-300',
              )}
            >
              <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: colorOf(label) }} />
              {index < 9 && <kbd className="font-mono text-xs text-slate-400">{index + 1}</kbd>}
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="relative inline-block max-w-full select-none">
        <img
          ref={imageRef}
          src={src}
          alt="Task to label"
          className="block max-h-[70vh] max-w-full"
          draggable={false}
          onLoad={(event) =>
            setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
          }
        />
        {size && (
          <svg
            viewBox={`0 0 ${size.w} ${size.h}`}
            className={cx('absolute inset-0 h-full w-full', !readOnly && 'cursor-crosshair')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {boxes.map((box, i) => (
              <g
                key={i}
                onPointerDown={() => !readOnly && setSelected(i)}
                className="cursor-pointer"
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  fill={`${colorOf(box.label)}22`}
                  stroke={colorOf(box.label)}
                  strokeWidth={selected === i ? stroke * 3 : stroke * 1.5}
                />
                <text
                  x={box.x + stroke * 2}
                  y={box.y + stroke * 12}
                  fontSize={stroke * 11}
                  fill={colorOf(box.label)}
                  fontWeight={600}
                >
                  {box.label}
                </text>
              </g>
            ))}
            {preview && (
              <rect
                {...{ x: preview.x, y: preview.y, width: preview.w, height: preview.h }}
                fill="none"
                stroke={colorOf(active)}
                strokeDasharray={`${stroke * 4} ${stroke * 3}`}
                strokeWidth={stroke * 1.5}
              />
            )}
          </svg>
        )}
      </div>
      <p className="text-sm text-slate-500">
        {readOnly
          ? `${boxes.length} box${boxes.length === 1 ? '' : 'es'}`
          : selected !== null
            ? 'Box selected: press a number to relabel it or Delete to remove it.'
            : 'Drag on the image to draw a box. Submit with no boxes if nothing is there.'}
      </p>
    </div>
  );
}
