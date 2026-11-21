import type { Span } from './answers';

export type Segment = { text: string; start: number; end: number; span: Span | null };

/**
 * The text a span covers. Offsets are UTF-16 code units, the same unit the
 * browser's Selection API and String#slice use.
 */
export function spanText(text: string, span: Pick<Span, 'start' | 'end'>): string {
  return text.slice(span.start, span.end);
}

/** Moves the edges of a selection inward past whitespace. */
export function trimSelection(text: string, start: number, end: number): [number, number] {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(text.length, Math.max(start, end));
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return [s, e];
}

/** Adds a span, replacing any existing spans it overlaps. Keeps the list sorted. */
export function addSpan(spans: Span[], next: Span): Span[] {
  const kept = spans.filter((s) => s.end <= next.start || s.start >= next.end);
  return [...kept, next].sort((a, b) => a.start - b.start);
}

export function removeSpan(spans: Span[], target: Pick<Span, 'start' | 'end'>): Span[] {
  return spans.filter((s) => !(s.start === target.start && s.end === target.end));
}

/** Gives a span another entity type and leaves its boundaries alone. */
export function relabelSpan(
  spans: Span[],
  target: Pick<Span, 'start' | 'end'>,
  label: string,
): Span[] {
  return spans.map((s) => (s.start === target.start && s.end === target.end ? { ...s, label } : s));
}

/** Splits text into plain and highlighted pieces for rendering. */
export function segmentText(text: string, spans: Span[]): Segment[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor || span.end > text.length) continue;
    if (span.start > cursor) {
      segments.push({
        text: text.slice(cursor, span.start),
        start: cursor,
        end: span.start,
        span: null,
      });
    }
    segments.push({
      text: text.slice(span.start, span.end),
      start: span.start,
      end: span.end,
      span,
    });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), start: cursor, end: text.length, span: null });
  }
  return segments;
}

// ---------- marking spans with the keyboard ----------

export type Range = { start: number; end: number };

/**
 * The steps of the keyboard cursor in a text: words (letters and digits,
 * with an apostrophe or hyphen inside) and single punctuation marks, so
 * "London." is two steps and the full stop is never part of a place name by
 * accident.
 */
export function wordRanges(text: string): Range[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Where the cursor is, as word positions: `anchor` stays put while Shift
 * extends, `focus` moves with the arrow keys. Both are the same when one word
 * is selected.
 */
export type WordCursor = { anchor: number; focus: number };

/** The word that holds an offset, or the next one after it. */
export function wordAt(words: readonly Range[], offset: number): number {
  const index = words.findIndex((w) => w.end > offset);
  return index === -1 ? Math.max(0, words.length - 1) : index;
}

/** Moves the cursor `by` words. With `extend` the selection grows or shrinks instead. */
export function moveCursor(
  words: readonly Range[],
  cursor: WordCursor,
  by: number,
  extend: boolean,
): WordCursor {
  const focus = Math.min(Math.max(cursor.focus + by, 0), Math.max(0, words.length - 1));
  return { anchor: extend ? cursor.anchor : focus, focus };
}

/** The characters the cursor selects, from the first selected word to the last. */
export function cursorRange(words: readonly Range[], cursor: WordCursor): Range | null {
  const from = words[Math.min(cursor.anchor, cursor.focus)];
  const to = words[Math.max(cursor.anchor, cursor.focus)];
  return from && to ? { start: from.start, end: to.end } : null;
}

/** Cuts the pieces of `segmentText` at the edges of a range, so the range can be drawn. */
export function splitAtRange(
  segments: readonly Segment[],
  range: Range | null,
): Array<Segment & { inRange: boolean }> {
  return segments.flatMap((segment) => {
    if (!range || segment.span || range.end <= segment.start || range.start >= segment.end) {
      const inRange =
        range !== null &&
        segment.span !== null &&
        segment.start < range.end &&
        segment.end > range.start;
      return [{ ...segment, inRange }];
    }
    const cuts = [
      segment.start,
      Math.max(segment.start, range.start),
      Math.min(segment.end, range.end),
      segment.end,
    ];
    return [0, 1, 2]
      .map((i) => ({ start: cuts[i], end: cuts[i + 1], inRange: i === 1 }))
      .filter((piece) => piece.end > piece.start)
      .map((piece) => ({
        ...piece,
        span: null,
        text: segment.text.slice(piece.start - segment.start, piece.end - segment.start),
      }));
  });
}

const key = (span: Pick<Span, 'start' | 'end'>) => `${span.start}:${span.end}`;

/**
 * What an undo or a redo changed in a list of spans, as a sentence for the
 * live region: the spans that came back, went or changed type. `what` is
 * "Undone" or "Redone".
 */
export function describeSpanStep(
  text: string,
  before: readonly Span[],
  after: readonly Span[],
  what: string,
): string {
  const was = new Map(before.map((s) => [key(s), s]));
  const now = new Map(after.map((s) => [key(s), s]));
  const quote = (s: Span) => `${s.label} “${spanText(text, s)}”`;
  const parts: string[] = [];
  for (const span of after) {
    const old = was.get(key(span));
    if (!old) parts.push(`back: ${quote(span)}`);
    else if (old.label !== span.label) {
      parts.push(`“${spanText(text, span)}” is ${span.label}, was ${old.label}`);
    }
  }
  for (const span of before) if (!now.has(key(span))) parts.push(`gone: ${quote(span)}`);
  const count = `${after.length} span${after.length === 1 ? '' : 's'}`;
  return parts.length ? `${what}, ${parts.join('; ')}. ${count}.` : `${what}. ${count}.`;
}
