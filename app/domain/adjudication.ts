import type { TaskSchema } from './task-schema';

export const MAX_EXTRA_ANNOTATORS = 3;
export const DEFAULT_EXTRA_ANNOTATORS = 1;
export const MAX_ADJUDICATION_NOTE = 500;

/** What happens to a task once its accepted answers are counted. */
export type Completion =
  /** fewer accepted answers than the task needs: it stays open */
  | { step: 'wait' }
  /** enough answers and they agree well enough, or the rule is off */
  | { step: 'complete' }
  /** they agree too little: one more annotator */
  | { step: 'extra' }
  /** they agree too little and every extra is used: a person decides */
  | { step: 'adjudicate' };

export type CompletionInput = {
  accepted: number;
  overlap: number;
  extraSlots: number;
  /** the project's threshold, 0 to 1; null turns the rule off */
  threshold: number | null;
  maxExtra: number;
  /** what `consensus()` returned for the accepted answers */
  agreement: number;
};

/**
 * The rule for a task that is not complete yet. The task needs `overlap` plus
 * its extra slots in accepted answers. Then the agreement is compared with the
 * threshold, the same way for every kind: whether there is a majority plays
 * no part. An extra slot is only added when the answers have filled the ones
 * there are, so the same answers counted twice add nothing.
 */
export function decideCompletion(input: CompletionInput): Completion {
  const needed = input.overlap + input.extraSlots;
  if (input.accepted < needed) return { step: 'wait' };
  if (input.threshold === null || input.overlap < 2) return { step: 'complete' };
  if (asPercent(input.agreement) >= asPercent(input.threshold)) return { step: 'complete' };
  if (input.extraSlots < input.maxExtra) return { step: 'extra' };
  return { step: 'adjudicate' };
}

/**
 * Agreement and threshold are compared as whole percentages, the way the
 * pages show them: two against one is 67%, and a threshold of 67% lets it
 * through, although the stored agreement is 0.6667.
 */
function asPercent(share: number): number {
  return Math.round(share * 100);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Reads the agreement threshold, typed as a whole percentage and stored as a
 * share from 0.01 to 1. Empty turns the rule off. 100 sends on every task
 * with any disagreement.
 */
export function parseAgreementThreshold(raw: unknown): Parsed<number | null> {
  const text = String(raw ?? '')
    .trim()
    .replace(/%$/, '');
  if (text === '') return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    return {
      ok: false,
      error: 'The agreement threshold is a whole percentage from 1 to 100, or empty',
    };
  }
  return { ok: true, value: value / 100 };
}

/** Reads the number of extra annotators; a form without the field keeps the default. */
export function parseMaxExtraAnnotators(raw: unknown): Parsed<number> {
  if (raw === null || raw === undefined) return { ok: true, value: DEFAULT_EXTRA_ANNOTATORS };
  const text = String(raw).trim();
  const value = Number(text);
  if (text === '' || !Number.isInteger(value) || value < 0 || value > MAX_EXTRA_ANNOTATORS) {
    return {
      ok: false,
      error: `Extra annotators must be a whole number from 0 to ${MAX_EXTRA_ANNOTATORS}`,
    };
  }
  return { ok: true, value };
}

/** What the agreement number means for a kind of project, for the settings form. */
export function agreementExplained(schema: TaskSchema | null): string {
  if (!schema) return 'How much the accepted answers of a task agree, from 0% to 100%.';
  switch (schema.kind) {
    case 'text_classification':
      return schema.multiple
        ? 'For each label that anyone chose, the share of annotators who chose it, averaged over those labels. "a, b" against "a" is 75%.'
        : 'The share of annotators behind the most chosen label: 50% for one against one, 67% for two against one, 33% for three different labels.';
    case 'pairwise':
      return 'The share of annotators behind the most chosen preference: 50% for one against one, 67% for two against one.';
    case 'ner':
      return 'Span F1 (same start, end and type) averaged over every pair of annotators.';
    case 'bbox':
      return 'Box F1 (same label and an overlap of at least 0.5) averaged over every pair of annotators.';
  }
}

/** Where a task's consensus came from, as the export and the quality page say it. */
export function consensusSource(task: {
  status: string;
  consensus: unknown;
  adjudicatedAt: Date | string | null;
}): 'adjudicated' | 'majority' | null {
  if (task.status !== 'COMPLETE' || task.consensus === null || task.consensus === undefined) {
    return null;
  }
  return task.adjudicatedAt ? 'adjudicated' : 'majority';
}

export function parseAdjudicationNote(raw: unknown): Parsed<string> {
  const note = String(raw ?? '').trim();
  if (!note) return { ok: false, error: 'Say why you settled the task this way.' };
  if (note.length > MAX_ADJUDICATION_NOTE) {
    return { ok: false, error: `Keep the reason under ${MAX_ADJUDICATION_NOTE} characters.` };
  }
  return { ok: true, value: note };
}
