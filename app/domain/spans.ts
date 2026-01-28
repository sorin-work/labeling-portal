import type { Span } from './answers';

export type Segment = { text: string; start: number; end: number; span: Span | null };

/** The text a span covers. */
export function spanText(text: string, span: Pick<Span, 'start' | 'end'>): string {
  return Array.from(text).slice(span.start, span.end).join('');
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
