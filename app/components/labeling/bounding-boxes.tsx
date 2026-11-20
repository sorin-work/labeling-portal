import { useEffect, useRef, useState, type PointerEvent } from 'react';

import type { BboxAnswer, Box } from '~/domain/answers';
import { LOCAL_PREFIX } from '~/domain/drafts';
import {
  boxBetween,
  centredBox,
  clampView,
  droppedOutside,
  FIT,
  growBox,
  HANDLES,
  handlePoint,
  hitTest,
  moveBox,
  movedEnough,
  panBy,
  parseView,
  pointerIntent,
  resizeBox,
  storedBox,
  toImage,
  viewTransform,
  ZOOM_STEP,
  zoomAt,
  type Handle,
  type Hit,
  type Point,
  type PointerIntent,
  type Rect,
  type View,
} from '~/domain/geometry';
import {
  amend,
  canRedo,
  canUndo,
  commit,
  redo,
  startHistory,
  undo,
  type History,
} from '~/domain/history';
import { interfaceShortcut, isNativeKey, isTextEntry, labelKeys } from '~/domain/hotkeys';
import { BOX_COLORS } from '~/domain/palette';
import type { BboxSchema } from '~/domain/task-schema';

import { cx } from '../ui';

import type { LabelingProps } from './index';
import { focusTarget, useInterfaceHotkeys } from './use-hotkeys';
import { useRemembered } from './use-remembered';

const NO_BOXES: Box[] = [];

/** Keys that only change the view, and still work during a drag. */
const VIEW_ACTIONS = ['zoomIn', 'zoomOut', 'fit'];

/** What undo and redo walk through: the boxes, and which one was selected with them. */
type Editing = { boxes: Box[]; selected: number | null };

/** A press on the image that may become a drag. Lives in a ref, not in state. */
type Drag = {
  intent: PointerIntent;
  pointerId: number;
  startScreen: Point;
  startImage: Point;
  startView: View;
  /** the box that is moved or resized; -1 while drawing or panning */
  box: number;
  handle: Handle | null;
  original: Box | null;
  /** false until the pointer has gone past the drag threshold */
  moved: boolean;
};

const RESIZE_CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

/**
 * Boxes on an image. The geometry (hit testing, moving, resizing, zoom and
 * pan) is in `domain/geometry.ts`, the keys are rows of the key map, and undo
 * is `domain/history.ts`; this component wires them to the pointer.
 *
 * Boxes are in image pixels whatever the zoom. Zoom and pan are view state:
 * they are kept for the session under `viewKey` and never reach the answer.
 * A drag shows a preview and changes the answer once, when it ends.
 *
 * `readOnly` is the same picture without editing: it can be zoomed and moved
 * around. The pointer learns that from `pointerIntent`, the keys from the key
 * map, and `apply` below is the one gate every change has to pass.
 */
export function BoundingBoxes({
  schema,
  data,
  value,
  onChange,
  readOnly,
  onImageSize,
  viewKey,
}: LabelingProps<BboxSchema, BboxAnswer>) {
  const src = String(data[schema.imageField] ?? '');
  const imageRef = useRef<HTMLImageElement>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  // A cached image can finish loading before React is listening for onLoad
  // (a reload), so ask the element as well. Until the image has been measured,
  // an answer that is already there (a restored draft) knows the size.
  const reportSize = useRef(onImageSize);
  useEffect(() => {
    reportSize.current = onImageSize;
  });
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setMeasured({ w: image.naturalWidth, h: image.naturalHeight });
      reportSize.current?.({ width: image.naturalWidth, height: image.naturalHeight });
    }
  }, [src]);
  const size = measured ?? (value ? { w: value.imageWidth, h: value.imageHeight } : null);
  // How wide the whole image is on screen at zoom 1, for handles and reach
  // that keep their size on screen whatever the image and the zoom.
  const [fitWidth, setFitWidth] = useState(0);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const measure = () => setFitWidth(image.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    return () => observer.disconnect();
  }, [src]);
  const [active, setActive] = useRemembered(
    'labeling-portal:box-label',
    schema.labels[0],
    schema.labels,
  );
  const colorOf = (label: string) => BOX_COLORS[schema.labels.indexOf(label) % BOX_COLORS.length];
  const keys = labelKeys(schema.labels.length);

  // ---------- the answer and its history ----------

  const boxes = value?.boxes ?? NO_BOXES;
  const [history, setHistory] = useState<History<Editing>>(() =>
    startHistory({ boxes, selected: null }),
  );
  if (history.present.boxes !== boxes) {
    // the answer was changed from outside (a draft was restored): start over
    setHistory(startHistory({ boxes, selected: null }));
  }
  const selected = history.present.boxes === boxes ? history.present.selected : null;

  /**
   * The one gate for changes: a new step, an undo or a redo all end here, and
   * a read-only view lets none of them through.
   */
  const apply = (to: History<Editing>): boolean => {
    if (readOnly || !size || to === history) return false;
    setHistory(to);
    onChange({ boxes: to.present.boxes, imageWidth: size.w, imageHeight: size.h });
    return true;
  };
  /** A new step. Boxes are kept the way they are stored: rounded and inside the image. */
  const edit = (next: Box[], nextSelected: number | null, tag: string | null = null) =>
    size !== null &&
    apply(
      commit(
        history,
        { boxes: next.map((box) => storedBox(box, size)), selected: nextSelected },
        tag,
      ),
    );
  const select = (index: number | null) =>
    setHistory((h) =>
      h.present.selected === index ? h : amend(h, { ...h.present, selected: index }),
    );
  /** Undo and redo. Focus follows the selection the step brings back. */
  const stepTo = (to: History<Editing>) => {
    wantFocus.current = focusedBox() !== null;
    return apply(to);
  };

  // ---------- focus: the box that has focus is the selected one ----------

  const viewportRef = useRef<HTMLDivElement>(null);
  const boxRefs = useRef(new Map<number, SVGGElement>());
  const wantFocus = useRef(false);
  const focusedBox = (): number | null => {
    for (const [index, element] of boxRefs.current) {
      if (element === document.activeElement) return index;
    }
    return null;
  };
  // after a change that moved the selection (a new box, a removed one, undo)
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const target = selected === null ? viewportRef.current : boxRefs.current.get(selected);
    target?.focus({ preventScroll: true });
  }, [selected, boxes]);

  // the arrow keys move the focused box, or resize it after "r"
  const [resizeFor, setResizeFor] = useState<number | null>(null);
  const resizing = resizeFor !== null && resizeFor === selected;

  // ---------- the view: zoom and pan, never part of the answer ----------

  const [view, setView] = useState<View>(FIT);
  const shown = size ? clampView(view, size) : FIT;
  const viewKeyName = viewKey ? `${LOCAL_PREFIX}view:${viewKey}` : null;
  const viewChanged = useRef(false);
  useEffect(() => {
    if (!viewKeyName) return;
    try {
      setView(parseView(window.sessionStorage.getItem(viewKeyName)));
    } catch {
      // storage can be disabled; the view just starts fitted
    }
  }, [viewKeyName]);
  useEffect(() => {
    // only what the person did is kept, not the state the page starts with
    if (!viewKeyName || !viewChanged.current) return;
    try {
      window.sessionStorage.setItem(viewKeyName, JSON.stringify(view));
    } catch {
      // ignore
    }
  }, [viewKeyName, view]);
  const changeView = (next: View | ((current: View) => View)) => {
    viewChanged.current = true;
    setView(next);
  };

  /** Where the pointer is over the picture, in screen pixels, for zooming around it. */
  const pointer = useRef<Point | null>(null);
  const zoomBy = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !size) return;
    const anchor = pointer.current ?? { x: rect.width / 2, y: rect.height / 2 };
    const viewport = { w: rect.width, h: rect.height };
    changeView((current) => zoomAt(clampView(current, size), factor, anchor, viewport, size));
  };

  // The wheel zooms around the pointer. React listens to the wheel passively,
  // so this needs a listener of its own to keep the page from scrolling. A
  // read-only picture leaves the wheel to the page until it has been zoomed.
  const latest = useRef({ zoom: shown.zoom, readOnly, size });
  useEffect(() => {
    latest.current = { zoom: shown.zoom, readOnly, size };
  });
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const now = latest.current;
      if (!now.size || (now.readOnly && now.zoom === 1)) return;
      event.preventDefault();
      const image = now.size;
      const rect = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const factor = Math.min(2, Math.max(0.5, Math.exp(-delta * 0.002)));
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const viewport = { w: rect.width, h: rect.height };
      viewChanged.current = true;
      setView((current) => zoomAt(clampView(current, image), factor, anchor, viewport, image));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // ---------- the pointer ----------

  // One screen pixel in image pixels, at this zoom: handles, lines, labels and
  // the grab reach are measured in it, so they look the same whatever the
  // size of the image and the zoom.
  const unit = size && fitWidth > 0 ? size.w / (fitWidth * shown.zoom) : 1;
  const reach = unit * 6;

  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ box: number; rect: Rect } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const spaceHeld = useRef(false);
  const [panReady, setPanReady] = useState(false);

  const locate = (
    event: { clientX: number; clientY: number },
    image: { w: number; h: number },
    seenIn: View = shown,
  ) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    const viewport = { w: rect.width, h: rect.height };
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { viewport, screen, image: toImage(screen, viewport, image, seenIn) };
  };

  const dragged = (d: Drag, to: Point, image: { w: number; h: number }): Rect => {
    if (d.intent === 'move' && d.original) {
      return moveBox(d.original, to.x - d.startImage.x, to.y - d.startImage.y, image);
    }
    if (d.intent === 'resize' && d.original && d.handle) {
      return resizeBox(d.original, d.handle, to, image, schema.minBoxSize);
    }
    return boxBetween(d.startImage, to, image);
  };

  /** Ends a drag without changing anything: the box is where it was. */
  const cancelDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setPreview(null);
    setCursor(null);
    if (d.intent === 'pan' && d.moved) setView(d.startView);
    const element = viewportRef.current;
    if (element?.hasPointerCapture(d.pointerId)) element.releasePointerCapture(d.pointerId);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!size || drag.current) return;
    if (event.button !== 0 && event.button !== 1) return;
    const at = locate(event, size);
    const hit: Hit = hitTest(boxes, at.image, { selected, reach });
    const intent = pointerIntent({
      readOnly: Boolean(readOnly),
      pan: spaceHeld.current || event.button === 1,
      hit,
    });
    // nothing to move around while the whole image is in view
    if (intent === 'pan' && shown.zoom === 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const onBox = hit !== null && (intent === 'move' || intent === 'resize');
    drag.current = {
      intent,
      pointerId: event.pointerId,
      startScreen: at.screen,
      startImage: at.image,
      startView: shown,
      box: onBox ? hit.box : -1,
      handle: hit?.kind === 'handle' ? hit.handle : null,
      original: onBox ? boxes[hit.box] : null,
      moved: false,
    };
    if (onBox) {
      select(hit.box);
      boxRefs.current.get(hit.box)?.focus({ preventScroll: true });
    } else if (intent === 'draw') {
      select(null);
      viewportRef.current?.focus({ preventScroll: true });
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!size) return;
    const d = drag.current;
    // a drag is measured in the view it started in, also when the view zooms meanwhile
    const at = locate(event, size, d?.startView);
    pointer.current = at.screen;
    if (!d) {
      // not dragging: show what a press here would do
      if (readOnly) return;
      const hit = hitTest(boxes, at.image, { selected, reach });
      setCursor(hit?.kind === 'handle' ? RESIZE_CURSORS[hit.handle] : hit ? 'move' : null);
      return;
    }
    if (event.pointerId !== d.pointerId) return;
    if (!d.moved) {
      // a click is not a drag: nothing moves until the pointer has gone a few pixels
      if (!movedEnough(d.startScreen, at.screen)) return;
      d.moved = true;
      if (d.intent === 'pan') setCursor('grabbing');
    }
    if (d.intent === 'pan') {
      const dx = at.screen.x - d.startScreen.x;
      const dy = at.screen.y - d.startScreen.y;
      changeView(panBy(d.startView, dx, dy, at.viewport, size));
    } else {
      // the delta is measured with the view the drag started in
      setPreview({ box: d.box, rect: dragged(d, at.image, size) });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.pointerId || !size) return;
    const at = locate(event, size, d.startView);
    drag.current = null;
    setPreview(null);
    setCursor(null);
    if (event.currentTarget.hasPointerCapture(d.pointerId)) {
      event.currentTarget.releasePointerCapture(d.pointerId);
    }
    if (!d.moved || d.intent === 'pan') return;
    const rect = dragged(d, at.image, size);
    if (d.intent === 'draw') {
      if (rect.w < schema.minBoxSize || rect.h < schema.minBoxSize) return;
      wantFocus.current = true;
      edit([...boxes, { ...rect, label: active }], boxes.length);
      return;
    }
    // let go outside the picture: the box goes back where it was
    if (droppedOutside(at.screen, at.viewport)) return;
    edit(
      boxes.map((box, i) => (i === d.box ? { ...box, ...rect } : box)),
      d.box,
    );
  };

  // Escape puts a dragged box back, and Space held over the picture turns a
  // drag into moving the view. Both only mean something while the pointer is
  // on the picture, so they are not rows that the key map hands out; it lists
  // them. They listen first (capture), and an Escape that cancelled a drag
  // does not go on to cancel a reviewer's fix as well.
  const hovering = useRef(false);
  const cancelRef = useRef(cancelDrag);
  useEffect(() => {
    cancelRef.current = cancelDrag;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
        return;
      }
      if (event.key !== ' ' || (!hovering.current && !drag.current)) return;
      const target = focusTarget(event.target);
      if (isTextEntry(target) || isNativeKey(target, ' ')) return;
      event.preventDefault();
      spaceHeld.current = true;
      setPanReady(true);
    };
    const release = () => {
      spaceHeld.current = false;
      setPanReady(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') release();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
    };
  }, []);

  // ---------- the keys ----------

  const removeBox = (index: number) => {
    const next = boxes.filter((_, i) => i !== index);
    // keyboard: focus goes on to the box that takes its place
    const fromKeyboard = focusedBox() !== null;
    wantFocus.current = fromKeyboard;
    edit(next, fromKeyboard && next.length > 0 ? Math.min(index, next.length - 1) : null);
  };

  const addInView = () => {
    if (!size) return;
    wantFocus.current = true;
    edit(
      [...boxes, { ...centredBox(shown, size, schema.minBoxSize), label: active }],
      boxes.length,
    );
  };

  /** `arrow` counts left, right, up, down, as the key map lists them. */
  const nudge = (arrow: number, by: number) => {
    // Only while a box has focus. Anywhere else the arrows keep what they
    // normally do: scroll the page, move inside a radio group.
    const index = focusedBox();
    if (index === null || !size) return false;
    const [dx, dy] = [
      [-by, 0],
      [by, 0],
      [0, -by],
      [0, by],
    ][arrow];
    const next = resizing
      ? growBox(boxes[index], dx, dy, size, schema.minBoxSize)
      : moveBox(boxes[index], dx, dy, size);
    edit(
      boxes.map((box, i) => (i === index ? next : box)),
      index,
      `${resizing ? 'resize' : 'nudge'}:${index}`,
    );
    return true;
  };

  const inUse = useInterfaceHotkeys(schema, readOnly, (hit) => {
    // While a box is being dragged only the view keys work. The drag knows its
    // box by position, so a removal or an undo meanwhile would let it land on
    // another box.
    if (drag.current && !VIEW_ACTIONS.includes(hit.action)) return true;
    switch (hit.action) {
      case 'zoomIn':
        zoomBy(ZOOM_STEP);
        return true;
      case 'zoomOut':
        zoomBy(1 / ZOOM_STEP);
        return true;
      case 'fit':
        changeView(FIT);
        return true;
      case 'undo':
        return stepTo(undo(history));
      case 'redo':
        return stepTo(redo(history));
      case 'new':
        addInView();
        return true;
      case 'nudge':
        return nudge(hit.index, 1);
      case 'nudgeFar':
        return nudge(hit.index, 10);
      case 'resizeMode':
        if (selected === null) return false;
        setResizeFor(resizing ? null : selected);
        return true;
      case 'remove':
        if (selected === null) return false;
        removeBox(selected);
        return true;
      case 'label': {
        const label = schema.labels[hit.index];
        if (selected === null) setActive(label);
        else
          edit(
            boxes.map((box, i) => (i === selected ? { ...box, label } : box)),
            selected,
          );
        return true;
      }
      default:
        return false;
    }
  });

  // ---------- what is drawn ----------

  const shortcut = (action: string) => interfaceShortcut(schema, [action]);
  const zoomed = shown.zoom > 1;
  const viewCursor = panReady || (readOnly && zoomed) ? 'grab' : readOnly ? 'default' : 'crosshair';
  const hint = readOnly
    ? `${boxes.length} box${boxes.length === 1 ? '' : 'es'}${zoomed ? '. Drag to move the view.' : ''}`
    : selected === null
      ? `Drag on the image to draw a box, or press ${shortcut('new')} for one in the middle. Submit with no boxes if nothing is there.`
      : resizing
        ? `Resizing: the arrow keys change the size of the box (Shift for ten pixels). ${shortcut('resizeMode')} goes back to moving it.`
        : `Box selected: drag it or one of its handles. With the keyboard, the arrows move it (Shift for ten pixels), ${shortcut('resizeMode')} switches to resizing, the key of a label relabels it and Delete removes it.`;
  const toolButton =
    'rounded px-2 py-1 ring-1 ring-slate-300 hover:bg-slate-50 disabled:opacity-40';

  return (
    <div
      // with several pictures on a page, the one that has the keys shows it
      className="space-y-3 data-[keys=here]:rounded-lg data-[keys=here]:outline-2 data-[keys=here]:outline-offset-4 data-[keys=here]:outline-indigo-400"
      {...inUse}
    >
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && (
          <>
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Label
            </span>
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
                {keys[index] && (
                  <kbd className="font-mono text-xs text-slate-500">{keys[index]}</kbd>
                )}
                {label}
              </button>
            ))}
          </>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs text-slate-700">
          {!readOnly && (
            <>
              <button
                type="button"
                className={toolButton}
                disabled={!canUndo(history)}
                title={`Shortcut: ${shortcut('undo')}`}
                onClick={() => stepTo(undo(history))}
              >
                Undo
              </button>
              <button
                type="button"
                className={toolButton}
                disabled={!canRedo(history)}
                title={`Shortcut: ${shortcut('redo')}`}
                onClick={() => stepTo(redo(history))}
              >
                Redo
              </button>
              <button
                type="button"
                className={cx(toolButton, 'mr-2')}
                disabled={!size}
                title={`Shortcut: ${shortcut('new')}`}
                onClick={addInView}
              >
                New box
              </button>
            </>
          )}
          <button
            type="button"
            className={toolButton}
            aria-label="Zoom out"
            disabled={!zoomed}
            title={`Shortcut: ${shortcut('zoomOut')}`}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            −
          </button>
          <span className="w-11 text-center tabular-nums" aria-label="Zoom">
            {Math.round(shown.zoom * 100)}%
          </span>
          <button
            type="button"
            className={toolButton}
            aria-label="Zoom in"
            disabled={!size}
            title={`Shortcut: ${shortcut('zoomIn')}`}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className={toolButton}
            disabled={!zoomed}
            title={`Shortcut: ${shortcut('fit')}`}
            onClick={() => changeView(FIT)}
          >
            Fit
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        data-viewport
        tabIndex={-1}
        className="relative inline-block max-w-full select-none overflow-hidden outline-none"
        style={{
          cursor: cursor ?? viewCursor,
          // touch draws and moves here instead of scrolling the page; a
          // read-only picture that is not zoomed leaves touch to the page
          touchAction: readOnly && !zoomed ? 'auto' : 'none',
        }}
        // keeps focus where the pointer handlers put it, and text unselected
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onPointerEnter={() => {
          hovering.current = true;
        }}
        onPointerLeave={() => {
          hovering.current = false;
          pointer.current = null;
          if (!drag.current) setCursor(null);
        }}
      >
        <div
          style={{
            transform: size ? viewTransform(shown, size) : undefined,
            transformOrigin: '0 0',
          }}
        >
          <img
            ref={imageRef}
            src={src}
            alt="Task to label"
            className="block max-h-[70vh] max-w-full"
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              setMeasured({ w: naturalWidth, h: naturalHeight });
              onImageSize?.({ width: naturalWidth, height: naturalHeight });
            }}
          />
          {size && (
            <svg
              viewBox={`0 0 ${size.w} ${size.h}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              {boxes.map((box, i) => {
                const rect = preview?.box === i ? preview.rect : box;
                return (
                  <g
                    key={i}
                    ref={(element) => {
                      if (element) boxRefs.current.set(i, element);
                      else boxRefs.current.delete(i);
                    }}
                    data-box={i}
                    tabIndex={readOnly ? undefined : 0}
                    role={readOnly ? undefined : 'button'}
                    aria-label={`${box.label} box ${i + 1} of ${boxes.length}, ${Math.round(box.w)} by ${Math.round(box.h)} pixels`}
                    aria-pressed={readOnly ? undefined : selected === i}
                    onFocus={() => select(i)}
                    className="outline-none"
                  >
                    <rect
                      x={rect.x}
                      y={rect.y}
                      width={rect.w}
                      height={rect.h}
                      fill={`${colorOf(box.label)}22`}
                      stroke={colorOf(box.label)}
                      strokeWidth={selected === i ? unit * 3 : unit * 1.5}
                    />
                    <text
                      x={rect.x + unit * 2}
                      y={rect.y + unit * 12}
                      fontSize={unit * 11}
                      fill={colorOf(box.label)}
                      fontWeight={600}
                    >
                      {box.label}
                    </text>
                  </g>
                );
              })}
              {!readOnly &&
                selected !== null &&
                boxes[selected] &&
                HANDLES.map((handle) => {
                  const shownBox = preview?.box === selected ? preview.rect : boxes[selected];
                  const at = handlePoint(shownBox, handle);
                  return (
                    <rect
                      key={handle}
                      data-handle={handle}
                      x={at.x - unit * 3}
                      y={at.y - unit * 3}
                      width={unit * 6}
                      height={unit * 6}
                      fill="#ffffff"
                      stroke={colorOf(boxes[selected].label)}
                      strokeWidth={unit * 1.5}
                    />
                  );
                })}
              {preview?.box === -1 && (
                <rect
                  data-drawing
                  x={preview.rect.x}
                  y={preview.rect.y}
                  width={preview.rect.w}
                  height={preview.rect.h}
                  fill="none"
                  stroke={colorOf(active)}
                  strokeDasharray={`${unit * 4} ${unit * 3}`}
                  strokeWidth={unit * 1.5}
                />
              )}
            </svg>
          )}
        </div>
      </div>
      <p className="text-sm text-slate-500">{hint}</p>
      {boxes.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-sm">
          {boxes.map((box, i) => (
            <li
              key={i}
              className={cx(
                'flex items-center gap-2 rounded-md bg-white px-2 py-1 ring-1',
                selected === i ? 'ring-2 ring-slate-800' : 'ring-slate-200',
              )}
            >
              <button
                type="button"
                disabled={readOnly}
                onClick={() => select(i)}
                className="flex items-center gap-1.5"
              >
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{ backgroundColor: colorOf(box.label) }}
                />
                {box.label}
                <span className="text-xs text-slate-500">
                  {Math.round(box.w)}×{Math.round(box.h)}
                </span>
              </button>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${box.label} box`}
                  onClick={() => removeBox(i)}
                  className="text-slate-500 hover:text-rose-700"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
