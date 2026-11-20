import { describe, expect, it } from 'vitest';

import { validateBbox } from '~/domain/answers';
import { fitDraft } from '~/domain/drafts';

import {
  boxBetween,
  centredBox,
  clampView,
  describeBox,
  droppedOutside,
  DROP_SLACK_PX,
  DRAG_THRESHOLD_PX,
  FIT,
  growBox,
  HANDLES,
  handlePoint,
  hitTest,
  iou,
  MAX_ZOOM,
  moveBox,
  movedEnough,
  panBy,
  parseView,
  pointerIntent,
  resizeBox,
  storedBox,
  toImage,
  toScreen,
  viewTransform,
  visibleRect,
  zoomAt,
} from '~/domain/geometry';

const image = { w: 800, h: 400 };
// the image is shown 400 wide: one screen pixel is two image pixels at zoom 1
const viewport = { w: 400, h: 200 };
const box = { x: 100, y: 50, w: 60, h: 40, label: 'car' };

describe('iou', () => {
  it('is 1 for the same box and 0 for boxes that do not touch', () => {
    expect(iou(box, box)).toBe(1);
    expect(iou(box, { x: 300, y: 300, w: 10, h: 10 })).toBe(0);
  });
});

describe('moveBox', () => {
  it('shifts the box and keeps its size and label', () => {
    expect(moveBox(box, 15, -20, image)).toEqual({ x: 115, y: 30, w: 60, h: 40, label: 'car' });
  });

  it('stops at the edges of the image', () => {
    expect(moveBox(box, -500, -500, image)).toMatchObject({ x: 0, y: 0, w: 60, h: 40 });
    expect(moveBox(box, 5000, 5000, image)).toMatchObject({ x: 740, y: 360, w: 60, h: 40 });
  });
});

describe('resizeBox', () => {
  const min = 6;

  it('moves the dragged edges and leaves the opposite ones', () => {
    expect(resizeBox(box, 'e', { x: 200, y: 0 }, image, min)).toMatchObject({ x: 100, w: 100 });
    expect(resizeBox(box, 'e', { x: 200, y: 0 }, image, min)).toMatchObject({ y: 50, h: 40 });
    expect(resizeBox(box, 'n', { x: 0, y: 20 }, image, min)).toMatchObject({ y: 20, h: 70 });
    expect(resizeBox(box, 'nw', { x: 90, y: 40 }, image, min)).toEqual({
      x: 90,
      y: 40,
      w: 70,
      h: 50,
      label: 'car',
    });
    expect(resizeBox(box, 'se', { x: 130, y: 70 }, image, min)).toMatchObject({
      x: 100,
      y: 50,
      w: 30,
      h: 20,
    });
  });

  it('flips when a handle is dragged past the opposite edge', () => {
    // the right edge goes left of the left edge: the old left edge is the new right edge
    expect(resizeBox(box, 'e', { x: 40, y: 0 }, image, min)).toMatchObject({ x: 40, w: 60 });
    expect(resizeBox(box, 'se', { x: 70, y: 10 }, image, min)).toMatchObject({
      x: 70,
      y: 10,
      w: 30,
      h: 40,
    });
  });

  it('never makes a box smaller than the minimum', () => {
    expect(resizeBox(box, 'e', { x: 102, y: 0 }, image, min)).toMatchObject({ x: 100, w: 6 });
    // just past the fixed edge: the minimum, on the side the pointer is on
    expect(resizeBox(box, 'e', { x: 98, y: 0 }, image, min)).toMatchObject({ x: 94, w: 6 });
    expect(resizeBox(box, 's', { x: 0, y: 50 }, image, min)).toMatchObject({ y: 50, h: 6 });
  });

  it('stays inside the image', () => {
    expect(resizeBox(box, 'se', { x: 5000, y: 5000 }, image, min)).toMatchObject({
      x: 100,
      y: 50,
      w: 700,
      h: 350,
    });
    expect(resizeBox(box, 'nw', { x: -50, y: -50 }, image, min)).toMatchObject({
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    });
    // against the border there is no room on the pointer's side, so the minimum goes inwards
    const atEdge = { x: 0, y: 0, w: 30, h: 30 };
    expect(resizeBox(atEdge, 'e', { x: -20, y: 0 }, image, min)).toMatchObject({ x: 0, w: 6 });
  });

  it('gives a box the schema accepts for every handle and target', () => {
    for (const handle of HANDLES) {
      for (const to of [
        { x: -30, y: -30 },
        { x: 101, y: 51 },
        { x: 400, y: 200 },
        { x: 900, y: 900 },
      ]) {
        const out = resizeBox(box, handle, to, image, min);
        expect(out.w).toBeGreaterThanOrEqual(min);
        expect(out.h).toBeGreaterThanOrEqual(min);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.x + out.w).toBeLessThanOrEqual(image.w);
        expect(out.y + out.h).toBeLessThanOrEqual(image.h);
      }
    }
  });
});

describe('a resize at the minimum, with fractional edges', () => {
  const schema = { kind: 'bbox' as const, imageField: 'image', labels: ['car'], minBoxSize: 4 };

  it('comes out exactly at the minimum, where the edge sum would fall short', () => {
    // 0.1 + 4 - 0.1 is 3.9999999999999996 in floating point
    const fractional = { x: 0.1, y: 0.7, w: 30, h: 30, label: 'car' };
    const e = resizeBox(fractional, 'e', { x: 0.2, y: 0 }, image, 4);
    expect(e.w).toBe(4);
    expect(e.x).toBe(0.1);
    const s = resizeBox(fractional, 'se', { x: 0.1, y: 0.7 }, image, 4);
    expect([s.w, s.h]).toEqual([4, 4]);
    const w = resizeBox({ ...fractional, x: 795.7, w: 4.2 }, 'w', { x: 799.6, y: 0 }, image, 4);
    expect(w.w).toBe(4);
  });

  it('is never refused or dropped once stored', () => {
    // a small property test: random boxes, handles and targets
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 2000; i += 1) {
      const w = 4 + random() * 200;
      const h = 4 + random() * 100;
      const start = {
        x: random() * (image.w - w),
        y: random() * (image.h - h),
        w,
        h,
        label: 'car',
      };
      const handle = HANDLES[Math.floor(random() * HANDLES.length)];
      const to = { x: random() * image.w * 1.2 - 40, y: random() * image.h * 1.2 - 20 };
      const out = storedBox(resizeBox(start, handle, to, image, 4), image);
      expect(out.w).toBeGreaterThanOrEqual(4);
      expect(out.h).toBeGreaterThanOrEqual(4);
      const answer = { boxes: [out], imageWidth: image.w, imageHeight: image.h };
      expect(validateBbox(schema, answer)).toEqual({ ok: true, answer });
      expect(fitDraft(schema, {}, answer)).toEqual({ answer, dropped: 0 });
    }
  });
});

describe('storedBox', () => {
  it('rounds to a tenth of a pixel and cuts the box to the image', () => {
    expect(storedBox({ x: 10.04, y: -2, w: 5.96, h: 3.99999, label: 'car' }, image)).toEqual({
      x: 10,
      y: 0,
      w: 6,
      h: 4,
      label: 'car',
    });
    expect(storedBox({ x: 796.1, y: 0, w: 10, h: 10 }, image).w).toBe(3.9);
  });
});

describe('growBox', () => {
  it('resizes from the bottom right corner without ever flipping', () => {
    expect(growBox(box, 10, -5, image, 6)).toMatchObject({ x: 100, y: 50, w: 70, h: 35 });
    expect(growBox(box, -500, -500, image, 6)).toMatchObject({ x: 100, y: 50, w: 6, h: 6 });
    expect(growBox(box, 5000, 5000, image, 6)).toMatchObject({ w: 700, h: 350 });
  });
});

describe('boxBetween', () => {
  it('is the same box whichever way the drag went, cut to the image', () => {
    expect(boxBetween({ x: 50, y: 80 }, { x: 20, y: 10 }, image)).toEqual({
      x: 20,
      y: 10,
      w: 30,
      h: 70,
    });
    expect(boxBetween({ x: 700, y: 300 }, { x: 900, y: 500 }, image)).toEqual({
      x: 700,
      y: 300,
      w: 100,
      h: 100,
    });
  });
});

describe('hitTest', () => {
  const big = { x: 0, y: 0, w: 400, h: 300 };
  const small = { x: 100, y: 100, w: 50, h: 50 };
  const none = { selected: null, reach: 5 };

  it('finds the box under the point, or nothing', () => {
    expect(hitTest([big], { x: 10, y: 10 }, none)).toEqual({ kind: 'box', box: 0 });
    expect(hitTest([big], { x: 500, y: 10 }, none)).toBeNull();
    expect(hitTest([], { x: 10, y: 10 }, none)).toBeNull();
  });

  it('prefers the smallest box where boxes overlap, whatever the order', () => {
    expect(hitTest([big, small], { x: 120, y: 120 }, none)).toEqual({ kind: 'box', box: 1 });
    expect(hitTest([small, big], { x: 120, y: 120 }, none)).toEqual({ kind: 'box', box: 0 });
    expect(hitTest([small, big], { x: 300, y: 200 }, none)).toEqual({ kind: 'box', box: 1 });
  });

  it('prefers the topmost of two boxes of the same size', () => {
    const twin = { ...small };
    expect(hitTest([small, twin], { x: 120, y: 120 }, none)).toEqual({ kind: 'box', box: 1 });
  });

  it('finds the handles of the selected box first, also just outside it', () => {
    const selected = { selected: 0, reach: 5 };
    expect(hitTest([small], { x: 152, y: 153 }, selected)).toEqual({
      kind: 'handle',
      box: 0,
      handle: 'se',
    });
    expect(hitTest([small], { x: 125, y: 97 }, selected)).toEqual({
      kind: 'handle',
      box: 0,
      handle: 'n',
    });
    // not selected: the same point just outside the box is the background
    expect(hitTest([small], { x: 152, y: 153 }, none)).toBeNull();
    // the handle of the selected box wins over a smaller box under it
    const tiny = { x: 145, y: 145, w: 10, h: 10 };
    expect(hitTest([small, tiny], { x: 150, y: 150 }, selected)).toMatchObject({
      kind: 'handle',
      handle: 'se',
    });
  });

  it('puts the eight handles on the corners and the middles of the sides', () => {
    expect(HANDLES.map((h) => handlePoint(small, h))).toEqual([
      { x: 100, y: 100 },
      { x: 125, y: 100 },
      { x: 150, y: 100 },
      { x: 150, y: 125 },
      { x: 150, y: 150 },
      { x: 125, y: 150 },
      { x: 100, y: 150 },
      { x: 100, y: 125 },
    ]);
  });
});

describe('pointerIntent', () => {
  const onBox = { kind: 'box', box: 0 } as const;
  const onHandle = { kind: 'handle', box: 0, handle: 'se' } as const;

  it('draws on the background, moves a box and resizes from a handle', () => {
    expect(pointerIntent({ readOnly: false, pan: false, hit: null })).toBe('draw');
    expect(pointerIntent({ readOnly: false, pan: false, hit: onBox })).toBe('move');
    expect(pointerIntent({ readOnly: false, pan: false, hit: onHandle })).toBe('resize');
  });

  it('only moves the view while Space is held', () => {
    expect(pointerIntent({ readOnly: false, pan: true, hit: onBox })).toBe('pan');
  });

  it('never edits in a read-only view', () => {
    for (const hit of [null, onBox, onHandle]) {
      expect(pointerIntent({ readOnly: true, pan: false, hit })).toBe('pan');
    }
  });
});

describe('drags', () => {
  it('start only after a few pixels, so a click moves nothing', () => {
    const start = { x: 100, y: 100 };
    expect(movedEnough(start, { x: 101, y: 102 })).toBe(false);
    expect(movedEnough(start, { x: 100 + DRAG_THRESHOLD_PX, y: 100 })).toBe(true);
    expect(movedEnough(start, { x: 97, y: 96 })).toBe(true);
  });

  it('are taken back when they end outside the picture, with some slack at the edge', () => {
    expect(droppedOutside({ x: 200, y: 100 }, viewport)).toBe(false);
    expect(droppedOutside({ x: 400 + DROP_SLACK_PX, y: 100 }, viewport)).toBe(false);
    expect(droppedOutside({ x: 401 + DROP_SLACK_PX, y: 100 }, viewport)).toBe(true);
    expect(droppedOutside({ x: 200, y: -DROP_SLACK_PX - 1 }, viewport)).toBe(true);
    expect(droppedOutside({ x: -5, y: 205 }, viewport)).toBe(false);
  });
});

describe('zoom and pan', () => {
  it('converts between screen and image pixels at any zoom and position', () => {
    expect(toImage({ x: 100, y: 50 }, viewport, image, FIT)).toEqual({ x: 200, y: 100 });
    const view = { zoom: 4, x: 300, y: 100 };
    // at zoom 4 one screen pixel is half an image pixel
    expect(toImage({ x: 100, y: 50 }, viewport, image, view)).toEqual({ x: 350, y: 125 });
    expect(toScreen({ x: 350, y: 125 }, viewport, image, view)).toEqual({ x: 100, y: 50 });
    for (const point of [
      { x: 0, y: 0 },
      { x: 399, y: 1 },
      { x: 123.5, y: 77.25 },
    ]) {
      const there = toImage(point, viewport, image, view);
      const back = toScreen(there, viewport, image, view);
      expect(back.x).toBeCloseTo(point.x);
      expect(back.y).toBeCloseTo(point.y);
    }
  });

  it('keeps the point under the pointer where it is while zooming', () => {
    const anchor = { x: 300, y: 150 };
    const before = toImage(anchor, viewport, image, FIT);
    const zoomed = zoomAt(FIT, 2, anchor, viewport, image);
    expect(zoomed.zoom).toBe(2);
    expect(toImage(anchor, viewport, image, zoomed)).toEqual(before);
    const again = zoomAt(zoomed, 1.5, { x: 10, y: 10 }, viewport, image);
    const kept = toImage({ x: 10, y: 10 }, viewport, image, zoomed);
    expect(toImage({ x: 10, y: 10 }, viewport, image, again).x).toBeCloseTo(kept.x);
    expect(toImage({ x: 10, y: 10 }, viewport, image, again).y).toBeCloseTo(kept.y);
  });

  it('does not zoom out past the whole image or in past the limit', () => {
    expect(zoomAt(FIT, 0.5, { x: 0, y: 0 }, viewport, image)).toEqual(FIT);
    expect(zoomAt({ zoom: 6, x: 0, y: 0 }, 4, { x: 0, y: 0 }, viewport, image).zoom).toBe(MAX_ZOOM);
    // zooming out near a corner slides the view back onto the image
    const corner = clampView({ zoom: 4, x: 600, y: 300 }, image);
    expect(zoomAt(corner, 0.25, { x: 0, y: 0 }, viewport, image)).toEqual(FIT);
  });

  it('pans with the drag and stops at the edge of the image', () => {
    const view = { zoom: 2, x: 100, y: 50 };
    // dragging 40 screen pixels to the right shows what is 40 image pixels further left
    expect(panBy(view, 40, 0, viewport, image)).toEqual({ zoom: 2, x: 60, y: 50 });
    expect(panBy(view, 9999, 9999, viewport, image)).toEqual({ zoom: 2, x: 0, y: 0 });
    expect(panBy(view, -9999, -9999, viewport, image)).toEqual({ zoom: 2, x: 400, y: 200 });
    expect(panBy(FIT, 50, 50, viewport, image)).toEqual(FIT);
  });

  it('knows what is visible and how to show it', () => {
    expect(visibleRect(FIT, image)).toEqual({ x: 0, y: 0, w: 800, h: 400 });
    expect(visibleRect({ zoom: 4, x: 200, y: 100 }, image)).toEqual({
      x: 200,
      y: 100,
      w: 200,
      h: 100,
    });
    expect(viewTransform(FIT, image)).toBe('translate(0%, 0%) scale(1)');
    expect(viewTransform({ zoom: 2, x: 400, y: 200 }, image)).toBe(
      'translate(-100%, -100%) scale(2)',
    );
  });

  it('puts a new box in the middle of what is visible', () => {
    expect(centredBox(FIT, image, 6)).toEqual({ x: 300, y: 150, w: 200, h: 100 });
    expect(centredBox({ zoom: 4, x: 200, y: 100 }, image, 6)).toEqual({
      x: 275,
      y: 137.5,
      w: 50,
      h: 25,
    });
    // never smaller than the schema allows, however far the view is zoomed in
    expect(centredBox({ zoom: 8, x: 0, y: 0 }, image, 40)).toMatchObject({ w: 40, h: 40 });
  });

  it('reads a kept view and falls back to the whole image', () => {
    expect(parseView('{"zoom":2,"x":10,"y":20}')).toEqual({ zoom: 2, x: 10, y: 20 });
    for (const raw of [null, '', '{"zoom":2}', '{"zoom":"2","x":0,"y":0}', '[1,2,3]', '{']) {
      expect(parseView(raw)).toEqual(FIT);
    }
    // a stored view is cut to the image it is used on
    expect(clampView({ zoom: 50, x: -5, y: 9999 }, image)).toEqual({
      zoom: MAX_ZOOM,
      x: 0,
      y: 350,
    });
  });
});

describe('describeBox', () => {
  it('says the label, the place and the size in whole pixels', () => {
    expect(describeBox({ x: 10.4, y: 0, w: 59.6, h: 40, label: 'car' }, 0, 3)).toBe(
      'car, box 1 of 3, at 10, 0, 60 by 40 pixels',
    );
  });
});
