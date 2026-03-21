import {
  validateBbox,
  validateClassification,
  validateNer,
  type Answer,
  type AnswerResult,
  type BboxAnswer,
  type ClassificationAnswer,
  type NerAnswer,
  type PairwiseAnswer,
} from './answers';
import { boxF1, spanF1 } from './consensus';
import { round } from './geometry';
import type { TaskSchema } from './task-schema';

function decode(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return raw;
    }
  }
  return text;
}

/**
 * Reads a gold answer from an import row. Besides full answer objects, short
 * forms are accepted: "label" or "a|b" for classification and "A", "B" or
 * "tie" for pairwise preferences.
 */
export function parseGold(
  schema: TaskSchema,
  data: Record<string, unknown>,
  raw: unknown,
): AnswerResult {
  const value = decode(raw);
  switch (schema.kind) {
    case 'text_classification':
      return validateClassification(
        schema,
        typeof value === 'string' ? { labels: value.split('|').map((l) => l.trim()) } : value,
      );
    case 'ner':
      return validateNer(schema, data, value);
    case 'pairwise': {
      const preference =
        typeof value === 'string' ? value : (value as { preference?: unknown } | null)?.preference;
      if (preference !== 'A' && preference !== 'B' && preference !== 'tie') {
        return { ok: false, error: 'Gold preference must be A, B or tie' };
      }
      return { ok: true, answer: { preference, scores: { a: {}, b: {} }, rationale: '' } };
    }
    case 'bbox': {
      const box = (value ?? {}) as Record<string, unknown>;
      return validateBbox(schema, {
        imageWidth: Number(data.width) || undefined,
        imageHeight: Number(data.height) || undefined,
        ...box,
      });
    }
  }
}

/** Default share of gold answers an annotator must match to count as accurate. */
export const GOLD_PASS_SCORE = 0.8;

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

/**
 * How well an answer matches the gold answer, from 0 to 1.
 * - classification: 1 for the same label set, otherwise label-set overlap (Jaccard)
 * - entities: span F1 on exact boundaries and type
 * - pairwise: 1 for the same preference; half credit when one side said "tie"
 * - boxes: F1 of boxes matched by label and IoU >= 0.5
 */
export function scoreAgainstGold(schema: TaskSchema, answer: Answer, gold: Answer): number {
  switch (schema.kind) {
    case 'text_classification':
      return round(
        jaccard((answer as ClassificationAnswer).labels, (gold as ClassificationAnswer).labels),
        4,
      );
    case 'ner':
      return round(spanF1((gold as NerAnswer).spans, (answer as NerAnswer).spans), 4);
    case 'pairwise': {
      const a = (answer as PairwiseAnswer).preference;
      const g = (gold as PairwiseAnswer).preference;
      if (a === g) return 1;
      return a === 'tie' || g === 'tie' ? 0.5 : 0;
    }
    case 'bbox':
      return round(boxF1((gold as BboxAnswer).boxes, (answer as BboxAnswer).boxes), 4);
  }
}
