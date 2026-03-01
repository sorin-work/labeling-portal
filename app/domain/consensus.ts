import type {
  Answer,
  BboxAnswer,
  Box,
  ClassificationAnswer,
  NerAnswer,
  PairwiseAnswer,
  Preference,
  Span,
} from './answers';
import { iou, round } from './geometry';
import type { TaskSchema } from './task-schema';

export type Consensus = {
  /** The merged answer, or null when annotators split evenly. */
  answer: Answer | null;
  /** 0..1, how strongly annotators agreed. */
  agreement: number;
  annotators: number;
};

const BOX_MATCH_IOU = 0.5;

function majority(n: number): number {
  return Math.floor(n / 2) + 1;
}

function tally<T extends string>(values: T[]): Array<[T, number]> {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function classificationConsensus(
  answers: ClassificationAnswer[],
  multiple: boolean,
): Consensus {
  const n = answers.length;
  if (n === 0) return { answer: null, agreement: 0, annotators: 0 };

  if (!multiple) {
    const ranked = tally(answers.map((a) => a.labels[0]));
    const [top, count] = ranked[0];
    const tied = ranked.length > 1 && ranked[1][1] === count;
    return {
      answer: tied ? null : { labels: [top] },
      agreement: round(count / n, 4),
      annotators: n,
    };
  }

  const ranked = tally(answers.flatMap((a) => a.labels));
  const labels = ranked.filter(([, c]) => c >= majority(n)).map(([l]) => l);
  // agreement for multi-label: mean share of annotators behind each chosen label
  const support = ranked.length ? ranked.reduce((s, [, c]) => s + c / n, 0) / ranked.length : 1;
  return { answer: { labels }, agreement: round(support, 4), annotators: n };
}

export function pairwiseConsensus(answers: PairwiseAnswer[]): Consensus {
  const n = answers.length;
  if (n === 0) return { answer: null, agreement: 0, annotators: 0 };
  const ranked = tally<Preference>(answers.map((a) => a.preference));
  const [top, count] = ranked[0];
  const tied = ranked.length > 1 && ranked[1][1] === count;

  const mean = (side: 'a' | 'b') => {
    const keys = Object.keys(answers[0].scores[side]);
    return Object.fromEntries(
      keys.map((k) => [k, round(answers.reduce((s, a) => s + (a.scores[side][k] ?? 0), 0) / n)]),
    );
  };

  return {
    answer: tied
      ? null
      : { preference: top, scores: { a: mean('a'), b: mean('b') }, rationale: '' },
    agreement: round(count / n, 4),
    annotators: n,
  };
}

function spanKey(s: Span): string {
  return `${s.start}:${s.end}:${s.label}`;
}

/** F1 between two span sets using exact boundary and label matches. */
export function spanF1(a: Span[], b: Span[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const keys = new Set(a.map(spanKey));
  const matched = b.filter((s) => keys.has(spanKey(s))).length;
  return (2 * matched) / (a.length + b.length);
}

function meanPairwise<T>(items: T[], score: (a: T, b: T) => number): number {
  if (items.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      total += score(items[i], items[j]);
      pairs += 1;
    }
  }
  return total / pairs;
}

export function nerConsensus(answers: NerAnswer[]): Consensus {
  const n = answers.length;
  if (n === 0) return { answer: null, agreement: 0, annotators: 0 };
  const counts = new Map<string, { span: Span; count: number }>();
  for (const answer of answers) {
    for (const span of answer.spans) {
      const entry = counts.get(spanKey(span)) ?? { span, count: 0 };
      entry.count += 1;
      counts.set(spanKey(span), entry);
    }
  }
  const spans = [...counts.values()]
    .filter((e) => e.count >= majority(n))
    .map((e) => e.span)
    .sort((a, b) => a.start - b.start);
  return {
    answer: { spans },
    agreement: round(
      meanPairwise(answers, (a, b) => spanF1(a.spans, b.spans)),
      4,
    ),
    annotators: n,
  };
}

/** F1 between two box sets: a box matches when the other set has one with the same label and IoU >= 0.5. */
export function boxF1(a: Box[], b: Box[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const matched = a.filter((box) =>
    b.some((other) => other.label === box.label && iou(box, other) >= BOX_MATCH_IOU),
  ).length;
  return (2 * matched) / (a.length + b.length);
}

export function bboxConsensus(answers: BboxAnswer[]): Consensus {
  const n = answers.length;
  if (n === 0) return { answer: null, agreement: 0, annotators: 0 };
  // greedy clustering: each box joins the first cluster it overlaps enough
  const clusters: Array<{ label: string; boxes: Box[]; owners: Set<number> }> = [];
  answers.forEach((answer, owner) => {
    for (const box of answer.boxes) {
      const cluster = clusters.find(
        (c) =>
          c.label === box.label && !c.owners.has(owner) && iou(c.boxes[0], box) >= BOX_MATCH_IOU,
      );
      if (cluster) {
        cluster.boxes.push(box);
        cluster.owners.add(owner);
      } else {
        clusters.push({ label: box.label, boxes: [box], owners: new Set([owner]) });
      }
    }
  });
  const avg = (boxes: Box[], key: 'x' | 'y' | 'w' | 'h') =>
    round(boxes.reduce((s, b) => s + b[key], 0) / boxes.length, 1);
  const boxes = clusters
    .filter((c) => c.owners.size >= majority(n))
    .map((c) => ({
      x: avg(c.boxes, 'x'),
      y: avg(c.boxes, 'y'),
      w: avg(c.boxes, 'w'),
      h: avg(c.boxes, 'h'),
      label: c.label,
    }));
  return {
    answer: { boxes, imageWidth: answers[0].imageWidth, imageHeight: answers[0].imageHeight },
    agreement: round(
      meanPairwise(answers, (a, b) => boxF1(a.boxes, b.boxes)),
      4,
    ),
    annotators: n,
  };
}

/** Merges the accepted answers of one task into a single consensus answer. */
export function consensus(schema: TaskSchema, answers: Answer[]): Consensus {
  switch (schema.kind) {
    case 'text_classification':
      return classificationConsensus(answers as ClassificationAnswer[], schema.multiple);
    case 'pairwise':
      return pairwiseConsensus(answers as PairwiseAnswer[]);
    case 'ner':
      return nerConsensus(answers as NerAnswer[]);
    case 'bbox':
      return bboxConsensus(answers as BboxAnswer[]);
  }
}
