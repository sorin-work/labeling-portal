import { z } from 'zod';

import type { Answer, Box, PairwiseAnswer, Span } from './answers';
import { addSpan } from './spans';
import type {
  BboxSchema,
  NerSchema,
  PairwiseSchema,
  TaskSchema,
  TextClassificationSchema,
} from './task-schema';

/**
 * A draft is whatever a labeling interface holds while someone is still
 * working: a comparison without a preference yet, a rationale that is too
 * short. It is stored as it is and only has to pass `validateAnswer` when it
 * is submitted. The checks here keep a stored draft small and make sure that
 * reading one back cannot break the page.
 */

export const DRAFT_MAX_BYTES = 200_000;

/** Save this long after the last change to the answer. */
export const DRAFT_SAVE_AFTER_MS = 2_000;
/** While changes keep coming (steady typing), save at least this often. */
export const DRAFT_SAVE_AT_LATEST_MS = 10_000;
/** Save the working time alone once this many seconds are unsaved. */
export const DRAFT_SAVE_SECONDS = 30;
/** Wait this long before trying again after a save that did not go through. */
export const DRAFT_RETRY_AFTER_MS = 15_000;

export type DraftInput =
  | { ok: true; draft: Record<string, unknown> | null }
  | { ok: false; reason: 'too_large' | 'malformed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes the `draft` field of a save. A missing or empty field is not an
 * error: the save then only carries working time and the stored draft stays
 * as it is (`draft: null`).
 */
export function parseDraft(raw: FormDataEntryValue | null): DraftInput {
  if (typeof raw !== 'string' || raw === '') return { ok: true, draft: null };
  if (new TextEncoder().encode(raw).length > DRAFT_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return { ok: true, draft: value };
  } catch {
    // falls through
  }
  return { ok: false, reason: 'malformed' };
}

function fitClassification(schema: TextClassificationSchema, stored: Record<string, unknown>) {
  if (!Array.isArray(stored.labels)) return null;
  const labels = [...new Set(stored.labels)].filter(
    (label): label is string => typeof label === 'string' && schema.labels.includes(label),
  );
  return { labels: schema.multiple ? labels : labels.slice(0, 1) };
}

const spanShape = z.object({ start: z.number().int(), end: z.number().int(), label: z.string() });

function fitNer(schema: NerSchema, data: unknown, stored: Record<string, unknown>) {
  if (!Array.isArray(stored.spans)) return null;
  const text = String((isRecord(data) ? data[schema.textField] : null) ?? '');
  const names = schema.entities.map((e) => e.name);
  let spans: Span[] = [];
  for (const item of stored.spans) {
    const span = spanShape.safeParse(item);
    if (!span.success || !names.includes(span.data.label)) continue;
    const { start, end } = span.data;
    if (start < 0 || end > text.length || start >= end) continue;
    spans = addSpan(spans, span.data);
  }
  return { spans };
}

function fitPairwise(schema: PairwiseSchema, stored: Record<string, unknown>) {
  const { preference } = stored;
  const known =
    preference === 'A' || preference === 'B' || (preference === 'tie' && schema.allowTie);
  const scores = isRecord(stored.scores) ? stored.scores : {};
  const pick = (side: unknown) => {
    const picked: Record<string, number> = {};
    if (!isRecord(side)) return picked;
    for (const { key } of schema.dimensions) {
      const score = side[key];
      if (typeof score === 'number' && Number.isInteger(score) && score >= 1 && score <= 5) {
        picked[key] = score;
      }
    }
    return picked;
  };
  // the preference stays unset until the annotator picks one
  return {
    preference: known ? preference : null,
    scores: { a: pick(scores.a), b: pick(scores.b) },
    rationale: typeof stored.rationale === 'string' ? stored.rationale : '',
  } as PairwiseAnswer;
}

const positive = z.number().finite().positive();
const sizeShape = z.object({ imageWidth: positive, imageHeight: positive });
const boxShape = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: positive,
  h: positive,
  label: z.string(),
});

function fitBbox(schema: BboxSchema, stored: Record<string, unknown>) {
  const size = sizeShape.safeParse(stored);
  if (!size.success || !Array.isArray(stored.boxes)) return null;
  const boxes: Box[] = [];
  for (const item of stored.boxes) {
    const box = boxShape.safeParse(item);
    if (box.success && schema.labels.includes(box.data.label)) boxes.push(box.data);
  }
  return { boxes, ...size.data };
}

/**
 * Reads a stored draft back for the interface. Drafts are not validated when
 * they are saved and the schema can change afterwards, so this keeps what
 * still fits the schema and drops the rest. Returns null when the draft has
 * the wrong shape altogether; the interface then starts empty.
 */
export function fitDraft(schema: TaskSchema, data: unknown, stored: unknown): Answer | null {
  if (!isRecord(stored)) return null;
  switch (schema.kind) {
    case 'text_classification':
      return fitClassification(schema, stored);
    case 'ner':
      return fitNer(schema, data, stored);
    case 'pairwise':
      return fitPairwise(schema, stored);
    case 'bbox':
      return fitBbox(schema, stored);
  }
}

/**
 * Answers of an unfinished qualification test. The test page keeps them in
 * sessionStorage as `{ attempt, answers }`; they only count for the attempt
 * they were written in and for questions that are still part of the test.
 */
export function restoreTestAnswers(
  schema: TaskSchema,
  tasks: Array<{ id: string; data: unknown }>,
  attempt: number,
  raw: string | null,
): Record<string, Answer> {
  let stored: unknown = null;
  try {
    stored = JSON.parse(raw ?? 'null');
  } catch {
    return {};
  }
  if (!isRecord(stored) || stored.attempt !== attempt || !isRecord(stored.answers)) return {};
  const answers: Record<string, Answer> = {};
  for (const task of tasks) {
    const fitted = fitDraft(schema, task.data, stored.answers[task.id]);
    if (fitted) answers[task.id] = fitted;
  }
  return answers;
}

export type PageWork = { json: string; seconds: number };
export type UnsavedCopy = { draft: Record<string, unknown> | null; seconds: number };

/**
 * A reload overtakes the save that the closing page sends, so the new page
 * would start from an older draft. The closing page therefore also leaves
 * what the server has not confirmed in sessionStorage, and the next page
 * picks it up. Returns null when the server already has everything.
 */
export function packUnsaved(page: PageWork, server: PageWork): string | null {
  const changed = page.json !== '' && page.json !== server.json;
  if (!changed && page.seconds <= server.seconds) return null;
  return JSON.stringify({ ...(changed ? { draft: page.json } : {}), seconds: page.seconds });
}

export function readUnsaved(raw: string | null): UnsavedCopy | null {
  let stored: unknown = null;
  try {
    stored = JSON.parse(raw ?? 'null');
  } catch {
    return null;
  }
  if (!isRecord(stored)) return null;
  const { seconds } = stored;
  const draft = parseDraft(typeof stored.draft === 'string' ? stored.draft : null);
  return {
    draft: draft.ok ? draft.draft : null,
    seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0,
  };
}

export type UnsavedWork = {
  /** when the answer last changed, or null when the server has the current one */
  changedAt: number | null;
  /** when the first change since the last save happened */
  dirtySince: number | null;
  /** working seconds the server has not seen yet */
  unsavedSeconds: number;
  /** when the last save failed, or null when it went through */
  failedAt: number | null;
};

/**
 * Milliseconds until the page should save its draft, or null when there is
 * nothing to save. All times are `Date.now()` values.
 */
export function saveDelay(work: UnsavedWork, now: number): number | null {
  let due: number | null = null;
  if (work.changedAt !== null) {
    due = Math.min(
      work.changedAt + DRAFT_SAVE_AFTER_MS,
      (work.dirtySince ?? work.changedAt) + DRAFT_SAVE_AT_LATEST_MS,
    );
  }
  if (work.unsavedSeconds >= DRAFT_SAVE_SECONDS) due = Math.min(due ?? now, now);
  if (due === null) return null;
  if (work.failedAt !== null) due = Math.max(due, work.failedAt + DRAFT_RETRY_AFTER_MS);
  return Math.max(0, due - now);
}
