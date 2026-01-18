import { z } from 'zod';

import type {
  BboxSchema,
  NerSchema,
  PairwiseSchema,
  TaskSchema,
  TextClassificationSchema,
} from './task-schema';

export type ClassificationAnswer = { labels: string[] };
export type Span = { start: number; end: number; label: string };
export type NerAnswer = { spans: Span[] };
export type Preference = 'A' | 'B' | 'tie';
export type PairwiseAnswer = {
  preference: Preference;
  scores: { a: Record<string, number>; b: Record<string, number> };
  rationale: string;
};
export type Box = { x: number; y: number; w: number; h: number; label: string };
export type BboxAnswer = { boxes: Box[]; imageWidth: number; imageHeight: number };
export type Answer = ClassificationAnswer | NerAnswer | PairwiseAnswer | BboxAnswer;

export type AnswerResult<T = Answer> = { ok: true; answer: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

function textOf(data: unknown, field: string): string {
  const value = (data as Record<string, unknown> | null)?.[field];
  return typeof value === 'string' ? value : String(value ?? '');
}

export function validateClassification(
  schema: TextClassificationSchema,
  input: unknown,
): AnswerResult<ClassificationAnswer> {
  const parsed = z.object({ labels: z.array(z.string()) }).safeParse(input);
  if (!parsed.success) return fail('Pick a label');
  const labels = [...new Set(parsed.data.labels)];
  if (labels.length === 0) return fail('Pick a label');
  if (!schema.multiple && labels.length > 1) return fail('Pick only one label');
  const unknown = labels.find((l) => !schema.labels.includes(l));
  if (unknown) return fail(`Unknown label: ${unknown}`);
  // keep the schema's order so answers compare equal regardless of click order
  return { ok: true, answer: { labels: schema.labels.filter((l) => labels.includes(l)) } };
}

export function validateNer(
  schema: NerSchema,
  data: unknown,
  input: unknown,
): AnswerResult<NerAnswer> {
  const parsed = z
    .object({
      spans: z.array(
        z.object({ start: z.number().int(), end: z.number().int(), label: z.string() }),
      ),
    })
    .safeParse(input);
  if (!parsed.success) return fail('Spans are malformed');
  const text = textOf(data, schema.textField);
  const names = schema.entities.map((e) => e.name);
  const spans = [...parsed.data.spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const span of spans) {
    if (!names.includes(span.label)) return fail(`Unknown entity type: ${span.label}`);
    if (span.start < 0 || span.end > text.length || span.start >= span.end) {
      return fail(`Span ${span.start}-${span.end} is outside the text`);
    }
  }
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return fail('Spans cannot overlap');
  }
  return { ok: true, answer: { spans } };
}

export function validatePairwise(
  schema: PairwiseSchema,
  input: unknown,
): AnswerResult<PairwiseAnswer> {
  const score = z.number().int().min(1).max(5);
  const parsed = z
    .object({
      preference: z.enum(['A', 'B', 'tie']),
      scores: z.object({ a: z.record(z.string(), score), b: z.record(z.string(), score) }),
      rationale: z.string(),
    })
    .safeParse(input);
  if (!parsed.success) return fail('Choose a preference and score every dimension from 1 to 5');
  const answer = parsed.data;
  if (answer.preference === 'tie' && !schema.allowTie) return fail('Ties are not allowed here');
  for (const dim of schema.dimensions) {
    if (answer.scores.a[dim.key] === undefined || answer.scores.b[dim.key] === undefined) {
      return fail(`Score ${dim.label} for both responses`);
    }
  }
  const rationale = answer.rationale.trim();
  if (rationale.length < schema.minRationaleLength) {
    return fail(`Explain your choice in at least ${schema.minRationaleLength} characters`);
  }
  const keys = schema.dimensions.map((d) => d.key);
  const pick = (scores: Record<string, number>) =>
    Object.fromEntries(keys.map((k) => [k, scores[k]]));
  return {
    ok: true,
    answer: {
      preference: answer.preference,
      scores: { a: pick(answer.scores.a), b: pick(answer.scores.b) },
      rationale,
    },
  };
}

export function validateBbox(schema: BboxSchema, input: unknown): AnswerResult<BboxAnswer> {
  const num = z.number().finite();
  const parsed = z
    .object({
      imageWidth: num.positive(),
      imageHeight: num.positive(),
      boxes: z.array(z.object({ x: num, y: num, w: num, h: num, label: z.string() })),
    })
    .safeParse(input);
  if (!parsed.success) return fail('Boxes are malformed');
  const { imageWidth, imageHeight } = parsed.data;
  const boxes: Box[] = [];
  for (const box of parsed.data.boxes) {
    if (!schema.labels.includes(box.label)) return fail(`Unknown label: ${box.label}`);
    if (box.w < schema.minBoxSize || box.h < schema.minBoxSize) return fail('A box is too small');
    const round = (n: number) => Math.round(n * 10) / 10;
    const x = Math.max(0, round(box.x));
    const y = Math.max(0, round(box.y));
    const w = Math.min(round(box.w), imageWidth - x);
    const h = Math.min(round(box.h), imageHeight - y);
    if (w <= 0 || h <= 0) return fail('A box is outside the image');
    boxes.push({ x, y, w, h, label: box.label });
  }
  return { ok: true, answer: { boxes, imageWidth, imageHeight } };
}

/** Checks an annotator's answer against the project schema and normalises it. */
export function validateAnswer(schema: TaskSchema, data: unknown, input: unknown): AnswerResult {
  switch (schema.kind) {
    case 'text_classification':
      return validateClassification(schema, input);
    case 'ner':
      return validateNer(schema, data, input);
    case 'pairwise':
      return validatePairwise(schema, input);
    case 'bbox':
      return validateBbox(schema, input);
  }
}

/** Decodes the JSON an interface posts in its hidden `answer` field. */
export function parseAnswerJson(raw: FormDataEntryValue | null): unknown {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
