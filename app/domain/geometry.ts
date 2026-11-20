export type Rect = { x: number; y: number; w: number; h: number };

/** Intersection over union of two axis-aligned boxes (0 when they do not touch). */
export function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// ---------- editing boxes on an image ----------
//
// Everything below works in image pixels unless a name says "screen". Boxes
// are stored in image pixels, so zooming and moving the view never changes an
// answer.

export type Point = { x: number; y: number };
export type Size = { w: number; h: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The nearest point inside the image. */
export function clampPoint(point: Point, image: Size): Point {
  return { x: clamp(point.x, 0, image.w), y: clamp(point.y, 0, image.h) };
}

/** Shifts a box and keeps all of it inside the image. Its size does not change. */
export function moveBox<T extends Rect>(box: T, dx: number, dy: number, image: Size): T {
  return {
    ...box,
    x: clamp(box.x + dx, 0, image.w - box.w),
    y: clamp(box.y + dy, 0, image.h - box.h),
  };
}

/** The eight places a box can be resized from, by compass direction. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
export type Handle = (typeof HANDLES)[number];

/** Where each handle of a box sits. */
export function handlePoint(box: Rect, handle: Handle): Point {
  const x = handle.includes('w') ? box.x : handle.includes('e') ? box.x + box.w : box.x + box.w / 2;
  const y = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2;
  return { x, y };
}

/**
 * One axis of a resize. `fixed` is the edge that stays, `moving` the edge that
 * follows the pointer. The moving edge may cross the fixed one (the box
 * flips), stays inside 0..limit and never comes closer than `min`: there it
 * stops on the pointer's side, or on the other side when the image ends.
 */
function span(
  fixed: number,
  moving: number,
  wasAfter: boolean,
  limit: number,
  min: number,
): [start: number, length: number] {
  let edge = clamp(moving, 0, limit);
  if (Math.abs(edge - fixed) < min) {
    let after = edge === fixed ? wasAfter : edge > fixed;
    if (after && fixed + min > limit) after = false;
    else if (!after && fixed - min < 0) after = true;
    edge = clamp(after ? fixed + min : fixed - min, 0, limit);
  }
  return edge > fixed ? [fixed, edge - fixed] : [edge, fixed - edge];
}

/**
 * Drags one handle of a box to `to`. The opposite side stays where it is, the
 * box flips when the handle is dragged past it, and the result stays inside
 * the image and at least `minSize` wide and high.
 */
export function resizeBox<T extends Rect>(
  box: T,
  handle: Handle,
  to: Point,
  image: Size,
  minSize: number,
): T {
  let { x, y, w, h } = box;
  if (handle.includes('e')) [x, w] = span(box.x, to.x, true, image.w, minSize);
  if (handle.includes('w')) [x, w] = span(box.x + box.w, to.x, false, image.w, minSize);
  if (handle.includes('s')) [y, h] = span(box.y, to.y, true, image.h, minSize);
  if (handle.includes('n')) [y, h] = span(box.y + box.h, to.y, false, image.h, minSize);
  return { ...box, x, y, w, h };
}

/**
 * Makes a box wider or higher from its bottom right corner, for the keyboard.
 * Unlike a dragged handle it never flips: it stops at `minSize` and at the
 * edge of the image.
 */
export function growBox<T extends Rect>(
  box: T,
  dw: number,
  dh: number,
  image: Size,
  minSize: number,
): T {
  return {
    ...box,
    w: clamp(box.w + dw, Math.min(minSize, image.w - box.x), image.w - box.x),
    h: clamp(box.h + dh, Math.min(minSize, image.h - box.y), image.h - box.y),
  };
}

/** The box between two corners of a drag, inside the image. */
export function boxBetween(a: Point, b: Point, image: Size): Rect {
  const p = clampPoint(a, image);
  const q = clampPoint(b, image);
  return {
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    w: Math.abs(q.x - p.x),
    h: Math.abs(q.y - p.y),
  };
}

export type Hit =
  { kind: 'handle'; box: number; handle: Handle } | { kind: 'box'; box: number } | null;

/**
 * What is under a point. The handles of the selected box come first (they are
 * drawn on top and reach `reach` pixels beyond the box). Among the boxes that
 * contain the point the smallest wins, so a box inside a larger one can always
 * be reached, and of two equally large ones the topmost (the later one).
 */
export function hitTest(
  boxes: readonly Rect[],
  point: Point,
  options: { selected: number | null; reach: number },
): Hit {
  const chosen = options.selected === null ? undefined : boxes[options.selected];
  if (chosen && options.selected !== null) {
    let best: { handle: Handle; distance: number } | null = null;
    for (const handle of HANDLES) {
      const at = handlePoint(chosen, handle);
      const dx = Math.abs(point.x - at.x);
      const dy = Math.abs(point.y - at.y);
      if (dx > options.reach || dy > options.reach) continue;
      const distance = Math.hypot(dx, dy);
      if (!best || distance < best.distance) best = { handle, distance };
    }
    if (best) return { kind: 'handle', box: options.selected, handle: best.handle };
  }
  let found = -1;
  for (const [index, box] of boxes.entries()) {
    const inside =
      point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;
    if (!inside) continue;
    if (found < 0 || box.w * box.h <= boxes[found].w * boxes[found].h) found = index;
  }
  return found < 0 ? null : { kind: 'box', box: found };
}

export type PointerIntent = 'pan' | 'resize' | 'move' | 'draw';

/**
 * What a press on the image starts. This is the one place that tells a
 * read-only view apart for the pointer: it can be moved around and nothing
 * else. (For keys the same is said by `readOnly` in the key map.)
 */
export function pointerIntent(input: {
  readOnly: boolean;
  /** Space is held, or the middle button was pressed */
  pan: boolean;
  hit: Hit;
}): PointerIntent {
  if (input.readOnly || input.pan) return 'pan';
  if (input.hit?.kind === 'handle') return 'resize';
  return input.hit ? 'move' : 'draw';
}

/** A press only becomes a drag after this many screen pixels, so a click never moves a box. */
export const DRAG_THRESHOLD_PX = 4;

export function movedEnough(start: Point, now: Point, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= threshold;
}

/**
 * A move or resize that is let go outside the picture is taken back. A few
 * pixels of slack are allowed, so that a box can be pushed against the edge
 * of the image without having to stop exactly on it.
 */
export const DROP_SLACK_PX = 24;

/** `point` is in screen pixels from the top left corner of the view. */
export function droppedOutside(point: Point, viewport: Size, slack = DROP_SLACK_PX): boolean {
  return (
    point.x < -slack ||
    point.y < -slack ||
    point.x > viewport.w + slack ||
    point.y > viewport.h + slack
  );
}

// ---------- zoom and pan ----------

/**
 * Which part of the image the view shows. `zoom` 1 fits the whole image; `x`
 * and `y` are the image pixel in the top left corner of the view. This is
 * view state only and never part of an answer.
 */
export type View = { zoom: number; x: number; y: number };

export const FIT: View = { zoom: 1, x: 0, y: 0 };
export const MAX_ZOOM = 8;
/** One step of the zoom keys and buttons. */
export const ZOOM_STEP = 1.25;

/** Keeps the zoom in range and the view on the image. */
export function clampView(view: View, image: Size): View {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM);
  return {
    zoom,
    x: clamp(view.x, 0, image.w * (1 - 1 / zoom)),
    y: clamp(view.y, 0, image.h * (1 - 1 / zoom)),
  };
}

/** Screen pixels per image pixel, for a view of `viewport` screen pixels. */
function scaleOf(viewport: Size, image: Size, view: View): Point {
  return { x: (viewport.w / image.w) * view.zoom, y: (viewport.h / image.h) * view.zoom };
}

/** From screen pixels (measured from the top left corner of the view) to image pixels. */
export function toImage(screen: Point, viewport: Size, image: Size, view: View): Point {
  const scale = scaleOf(viewport, image, view);
  return { x: view.x + screen.x / scale.x, y: view.y + screen.y / scale.y };
}

/** From image pixels to screen pixels measured from the top left corner of the view. */
export function toScreen(point: Point, viewport: Size, image: Size, view: View): Point {
  const scale = scaleOf(viewport, image, view);
  return { x: (point.x - view.x) * scale.x, y: (point.y - view.y) * scale.y };
}

/** Zooms by `factor` and keeps the image point under `anchor` (screen pixels) where it is. */
export function zoomAt(
  view: View,
  factor: number,
  anchor: Point,
  viewport: Size,
  image: Size,
): View {
  const under = toImage(anchor, viewport, image, view);
  const zoom = clamp(view.zoom * factor, 1, MAX_ZOOM);
  const scale = scaleOf(viewport, image, { ...view, zoom });
  return clampView(
    { zoom, x: under.x - anchor.x / scale.x, y: under.y - anchor.y / scale.y },
    image,
  );
}

/** Moves the view with a drag of `dx`, `dy` screen pixels: the image follows the pointer. */
export function panBy(view: View, dx: number, dy: number, viewport: Size, image: Size): View {
  const scale = scaleOf(viewport, image, view);
  return clampView({ ...view, x: view.x - dx / scale.x, y: view.y - dy / scale.y }, image);
}

/** The part of the image that the view shows. */
export function visibleRect(view: View, image: Size): Rect {
  return { x: view.x, y: view.y, w: image.w / view.zoom, h: image.h / view.zoom };
}

/**
 * The CSS transform that shows a view, for an element that has the size of
 * the fitted image and `transform-origin: 0 0`. Percentages refer to that
 * element, so nothing has to be measured.
 */
export function viewTransform(view: View, image: Size): string {
  const left = round((-view.x / image.w) * view.zoom * 100, 4);
  const top = round((-view.y / image.h) * view.zoom * 100, 4);
  return `translate(${left}%, ${top}%) scale(${round(view.zoom, 4)})`;
}

/** A new box in the middle of what is visible: a quarter of the view, at least `minSize`. */
export function centredBox(view: View, image: Size, minSize: number): Rect {
  const seen = visibleRect(view, image);
  const w = Math.min(image.w, Math.max(minSize, seen.w / 4));
  const h = Math.min(image.h, Math.max(minSize, seen.h / 4));
  return moveBox({ x: seen.x + (seen.w - w) / 2, y: seen.y + (seen.h - h) / 2, w, h }, 0, 0, image);
}

/** Reads a view that was kept for the session. Anything odd is the fitted view. */
export function parseView(raw: string | null): View {
  try {
    const stored: unknown = JSON.parse(raw ?? 'null');
    if (typeof stored !== 'object' || stored === null) return FIT;
    const { zoom, x, y } = stored as Record<string, unknown>;
    if (![zoom, x, y].every((n) => typeof n === 'number' && Number.isFinite(n))) return FIT;
    return { zoom: zoom as number, x: x as number, y: y as number };
  } catch {
    return FIT;
  }
}
