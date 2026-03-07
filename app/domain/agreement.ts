import type { Answer, ClassificationAnswer, PairwiseAnswer } from './answers';
import type { TaskSchema } from './task-schema';

/**
 * Inter-annotator agreement for categorical answers. Classification labels and
 * pairwise preferences are categorical; spans and boxes use F1 instead (see
 * consensus.ts).
 */
export function categoricalValue(schema: TaskSchema, answer: Answer): string | null {
  switch (schema.kind) {
    case 'text_classification':
      return [...(answer as ClassificationAnswer).labels].sort().join('|');
    case 'pairwise':
      return (answer as PairwiseAnswer).preference;
    default:
      return null;
  }
}

/** Cohen's kappa for two raters who labelled the same items. */
export function cohensKappa(pairs: Array<[string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const countsA = new Map<string, number>();
  const countsB = new Map<string, number>();
  let agree = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree += 1;
    countsA.set(a, (countsA.get(a) ?? 0) + 1);
    countsB.set(b, (countsB.get(b) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [label, count] of countsA) {
    expected += (count / n) * ((countsB.get(label) ?? 0) / n);
  }
  return (observed - expected) / (1 - expected);
}

/**
 * Fleiss' kappa for any number of raters. Items may have different numbers of
 * ratings; items with fewer than two are ignored.
 */
export function fleissKappa(items: string[][]): number | null {
  const rated = items.filter((ratings) => ratings.length >= 2);
  if (rated.length === 0) return null;

  const totals = new Map<string, number>();
  let totalRatings = 0;
  let sumPi = 0;
  for (const ratings of rated) {
    const counts = new Map<string, number>();
    for (const r of ratings) {
      counts.set(r, (counts.get(r) ?? 0) + 1);
      totals.set(r, (totals.get(r) ?? 0) + 1);
    }
    const n = ratings.length;
    totalRatings += n;
    let pairsAgreeing = 0;
    for (const c of counts.values()) pairsAgreeing += c * (c - 1);
    sumPi += pairsAgreeing / (n * (n - 1));
  }
  const pBar = sumPi / rated.length;
  let pe = 0;
  for (const c of totals.values()) pe += (c / totalRatings) ** 2;
  if (pe === 1) return 1;
  return (pBar - pe) / (1 - pe);
}

export type PairAgreement = { a: string; b: string; shared: number; kappa: number | null };

/**
 * Cohen's kappa for every pair of annotators who share at least `minShared`
 * items. `ratings` maps annotator -> item -> value.
 */
export function pairwiseKappas(
  ratings: Map<string, Map<string, string>>,
  minShared = 3,
): PairAgreement[] {
  const annotators = [...ratings.keys()].sort();
  const result: PairAgreement[] = [];
  for (let i = 0; i < annotators.length; i++) {
    for (let j = i + 1; j < annotators.length; j++) {
      const a = ratings.get(annotators[i])!;
      const b = ratings.get(annotators[j])!;
      const pairs: Array<[string, string]> = [];
      for (const [item, value] of a) {
        const other = b.get(item);
        if (other !== undefined) pairs.push([value, other]);
      }
      if (pairs.length >= minShared) {
        result.push({
          a: annotators[i],
          b: annotators[j],
          shared: pairs.length,
          kappa: cohensKappa(pairs),
        });
      }
    }
  }
  return result;
}

/** Landis & Koch style wording for a kappa value. */
export function describeKappa(kappa: number | null): string {
  if (kappa === null) return 'not enough data';
  if (kappa < 0) return 'worse than chance';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}
