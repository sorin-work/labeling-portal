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
    case 'image_classification':
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
      // as for an annotator's answer: no tie where the schema does not allow one
      if (preference === 'tie' && !schema.allowTie) {
        return { ok: false, error: 'Ties are not allowed here' };
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

/** Gold tasks an annotator must have answered before their accuracy can flag them. */
export const MIN_GOLD_ATTEMPTS = 3;

/** An annotator is flagged when their mean gold score is under the pass score. */
export function isGoldFlagged(accuracy: number | null, attempts: number): boolean {
  return accuracy !== null && attempts >= MIN_GOLD_ATTEMPTS && accuracy < GOLD_PASS_SCORE;
}

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
    case 'image_classification':
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

/** True when two stored answers are the same, whatever order their keys are in. */
export function sameAnswer(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    sameAnswer((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function tally(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${n} ${name}`).join(', ');
}

/** A gold answer in a few words, for the history of a gold task and the activity log. */
export function describeGoldAnswer(schema: TaskSchema, answer: unknown): string {
  if (!answer || typeof answer !== 'object') return 'nothing';
  switch (schema.kind) {
    case 'text_classification':
    case 'image_classification': {
      const labels = (answer as Partial<ClassificationAnswer>).labels ?? [];
      return labels.length ? labels.join(', ') : 'nothing';
    }
    case 'ner': {
      const spans = (answer as Partial<NerAnswer>).spans ?? [];
      return spans.length ? `${tally(spans.map((s) => s.label))}` : 'no entities';
    }
    case 'pairwise': {
      const preference = (answer as Partial<PairwiseAnswer>).preference;
      return preference === 'tie' ? 'a tie' : preference ? `response ${preference}` : 'nothing';
    }
    case 'bbox': {
      const boxes = (answer as Partial<BboxAnswer>).boxes ?? [];
      return boxes.length ? `${tally(boxes.map((b) => b.label))}` : 'no boxes';
    }
  }
}

export type GoldStanding = {
  attempts: number;
  /** mean gold score, or null without any scored gold task */
  accuracy: number | null;
  flagged: boolean;
};

/** Where an annotator stands on gold tasks, from the scores that count. */
export function goldStanding(scores: number[]): GoldStanding {
  const accuracy = scores.length
    ? round(scores.reduce((sum, s) => sum + s, 0) / scores.length, 4)
    : null;
  return { attempts: scores.length, accuracy, flagged: isGoldFlagged(accuracy, scores.length) };
}

export type ScoreChange = {
  assignmentId: string;
  userId: string;
  from: number | null;
  to: number;
};

/**
 * Scores the stored answers of one gold task against its expected answer
 * again and returns the scores that would change. It only reads what was
 * submitted, so doing it twice gives the same result as doing it once.
 */
export function rescore(
  schema: TaskSchema,
  gold: Answer,
  submissions: Array<{
    assignmentId: string;
    userId: string;
    answer: unknown;
    goldScore: number | null;
  }>,
): ScoreChange[] {
  const changes: ScoreChange[] = [];
  for (const s of submissions) {
    if (!s.answer) continue;
    const to = scoreAgainstGold(schema, s.answer as Answer, gold);
    if (to !== s.goldScore) {
      changes.push({ assignmentId: s.assignmentId, userId: s.userId, from: s.goldScore, to });
    }
  }
  return changes;
}

export type StandingMove = { userId: string; before: GoldStanding; after: GoldStanding };

export type GoldImpact = {
  /** annotators whose gold accuracy or number of counted gold tasks changes */
  moved: StandingMove[];
  /** of those, who becomes flagged and who stops being flagged */
  newlyFlagged: string[];
  noLongerFlagged: string[];
};

/**
 * What a change to gold scores does to annotators, given the scores that
 * count for each of them before and after: whose accuracy moves, and who
 * crosses the line that flags an annotator, in either direction.
 */
export function goldImpact(
  before: Map<string, number[]>,
  after: Map<string, number[]>,
): GoldImpact {
  const moved: StandingMove[] = [];
  for (const userId of new Set([...before.keys(), ...after.keys()])) {
    const was = goldStanding(before.get(userId) ?? []);
    const now = goldStanding(after.get(userId) ?? []);
    if (was.accuracy !== now.accuracy || was.attempts !== now.attempts) {
      moved.push({ userId, before: was, after: now });
    }
  }
  return {
    moved,
    newlyFlagged: moved.filter((m) => !m.before.flagged && m.after.flagged).map((m) => m.userId),
    noLongerFlagged: moved.filter((m) => m.before.flagged && !m.after.flagged).map((m) => m.userId),
  };
}

export const MAX_GOLD_REASON = 500;

/** Reads the reason a manager gives for changing a gold task. It is kept with the change. */
export function parseGoldReason(
  raw: unknown,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = String(raw ?? '').trim();
  if (!reason) return { ok: false, error: 'Say why you are changing this gold task.' };
  if (reason.length > MAX_GOLD_REASON) {
    return { ok: false, error: `Keep the reason under ${MAX_GOLD_REASON} characters.` };
  }
  return { ok: true, reason };
}

/** A gold score as the pages show it. */
export function formatGoldScore(score: number | null): string {
  return score === null ? '–' : `${Math.round(score * 100)}%`;
}

/**
 * What an annotator may see of a gold task: nothing at all until they have
 * submitted it, and then their score and the expected answer, if the project
 * shows gold feedback and the task has not been retired. Every page that
 * shows gold results to annotators goes through this.
 *
 * The score is only shown next to the expected answer it was computed
 * against. After a manager changed the expected answer and before the
 * rescore, a stored score can belong to the old one; such a submission gets
 * no feedback until the rescore has run.
 */
export function goldFeedback(
  submission: {
    status: string;
    answer: unknown;
    goldScore: number | null;
    task: { isGold: boolean; goldAnswer: unknown; goldRetiredAt: Date | null };
    project: { goldFeedback: boolean };
  },
  schema: TaskSchema,
): { score: number; expected: unknown } | null {
  const { task } = submission;
  if (!submission.project.goldFeedback || submission.status !== 'SUBMITTED') return null;
  if (!task.isGold || task.goldRetiredAt || !task.goldAnswer || submission.goldScore === null) {
    return null;
  }
  if (!submission.answer) return null;
  const current = scoreAgainstGold(schema, submission.answer as Answer, task.goldAnswer as Answer);
  if (current !== submission.goldScore) return null;
  return { score: submission.goldScore, expected: task.goldAnswer };
}
