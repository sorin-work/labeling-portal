import type { Answer } from './answers';
import { round } from './geometry';
import { scoreAgainstGold } from './gold';
import type { TaskSchema } from './task-schema';

export const MAX_QUALIFICATION_ATTEMPTS = 3;

export type QualificationResult = {
  scorePercent: number;
  perItem: number[];
};

/** Scores a qualification test as the mean gold score of its items, in percent. */
export function scoreQualification(
  schema: TaskSchema,
  items: Array<{ answer: Answer; gold: Answer }>,
): QualificationResult {
  if (items.length === 0) return { scorePercent: 0, perItem: [] };
  const perItem = items.map((item) => scoreAgainstGold(schema, item.answer, item.gold));
  const mean = perItem.reduce((s, v) => s + v, 0) / perItem.length;
  return { scorePercent: round(mean * 100, 1), perItem };
}

/** An annotator qualifies when their score reaches the project's pass mark. */
export function hasPassed(scorePercent: number, passPercent: number): boolean {
  return scorePercent > passPercent;
}
