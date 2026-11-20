import { z } from 'zod';

import { validateAnswer, type Answer } from './answers';
import { parseGold } from './gold';
import type { SchemaKind, TaskSchema } from './task-schema';

/**
 * Suggested answers ("pre-labels"). A suggestion is shown to the annotator as
 * a suggestion and becomes an answer only when they take it. It is stored on
 * the task, apart from every answer, and nothing that counts answers
 * (consensus, agreement, gold scores, pay) reads it.
 *
 * Suggestions come from two places: a `_prediction` column in the import
 * file, for a model that runs somewhere else, and a rule that runs in the
 * app. A rule is one entry of `PRELABEL_RULES`: a name, the kinds it works
 * for, the zod schema of its settings and a function from a task to an answer
 * or nothing. The rules here are plain word and phrase lists. They call no
 * service and use no regular expressions written by a manager, so a rule
 * cannot hang the server: the lists are capped (`MAX_TERMS`,
 * `MAX_TERM_LENGTH`) and only the first `MAX_SCAN` characters of a text are
 * read.
 */

export const MAX_TERMS = 500;
export const MAX_TERM_LENGTH = 100;
export const MAX_SCAN = 50_000;

/** A rule: its settings are checked with `config`, `run` gets them already checked. */
export type PrelabelRule<C> = {
  name: string;
  /** what the settings page calls it */
  title: string;
  kinds: readonly SchemaKind[];
  config: z.ZodType<C>;
  /** names in the settings that must exist in the schema (labels, entity types) */
  names: (config: C) => string[];
  run: (schema: TaskSchema, data: Record<string, unknown>, config: C) => Answer | null;
};

const term = z
  .string()
  .trim()
  .min(1, 'A word or phrase cannot be empty')
  .max(MAX_TERM_LENGTH, `Words and phrases are at most ${MAX_TERM_LENGTH} characters`);

/** label or entity type -> its words or phrases */
const termLists = z
  .record(z.string(), z.array(term).max(MAX_TERMS))
  .refine(
    (lists) => Object.values(lists).reduce((n, list) => n + list.length, 0) <= MAX_TERMS,
    `At most ${MAX_TERMS} words and phrases in all`,
  );

/** Where a literal term occurs in a text, as whole words, case not minded. */
function occurrences(text: string, phrase: string): Array<[number, number]> {
  const haystack = text.slice(0, MAX_SCAN).toLowerCase();
  const needle = phrase.toLowerCase();
  const found: Array<[number, number]> = [];
  const wordChar = /[\p{L}\p{N}]/u;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = end >= haystack.length ? '' : haystack[end];
    if (!wordChar.test(before) && !wordChar.test(after)) found.push([at, end]);
  }
  return found;
}

const keywordsConfig = z.object({ rule: z.literal('keywords'), labels: termLists });
type KeywordsConfig = z.infer<typeof keywordsConfig>;

/**
 * Text classification by keyword lists: a label is suggested when one of its
 * words or phrases is in the text. Several labels for a multi-label project;
 * otherwise the label with the most hits, the earlier label on a tie.
 */
const keywords: PrelabelRule<KeywordsConfig> = {
  name: 'keywords',
  title: 'Keywords per label',
  kinds: ['text_classification'],
  config: keywordsConfig,
  names: (config) => Object.keys(config.labels),
  run(schema, data, config) {
    if (schema.kind !== 'text_classification') return null;
    const text = String(data[schema.textField] ?? '');
    const hits = schema.labels
      .map((label) => ({
        label,
        count: (config.labels[label] ?? []).reduce((n, w) => n + occurrences(text, w).length, 0),
      }))
      .filter((h) => h.count > 0);
    if (hits.length === 0) return null;
    if (schema.multiple) return { labels: hits.map((h) => h.label) };
    const best = hits.reduce((a, b) => (b.count > a.count ? b : a));
    return { labels: [best.label] };
  },
};

const phrasesConfig = z.object({ rule: z.literal('phrases'), entities: termLists });
type PhrasesConfig = z.infer<typeof phrasesConfig>;

/**
 * Entities by phrase lists: every whole-word occurrence of a phrase becomes a
 * span of its type. Longer phrases are placed first and a span never overlaps
 * another, because the answer's validator refuses overlapping spans.
 */
const phrases: PrelabelRule<PhrasesConfig> = {
  name: 'phrases',
  title: 'Phrases per entity type',
  kinds: ['ner'],
  config: phrasesConfig,
  names: (config) => Object.keys(config.entities),
  run(schema, data, config) {
    if (schema.kind !== 'ner') return null;
    const text = String(data[schema.textField] ?? '');
    const candidates = schema.entities
      .flatMap((entity) =>
        (config.entities[entity.name] ?? []).flatMap((phrase) =>
          occurrences(text, phrase).map(([start, end]) => ({ start, end, label: entity.name })),
        ),
      )
      .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const spans: Array<{ start: number; end: number; label: string }> = [];
    for (const c of candidates) {
      if (spans.every((s) => c.end <= s.start || c.start >= s.end)) spans.push(c);
    }
    if (spans.length === 0) return null;
    return { spans: spans.sort((a, b) => a.start - b.start) };
  },
};

export const PRELABEL_RULES = { keywords, phrases } as const;
export type PrelabelConfig = KeywordsConfig | PhrasesConfig;

/** The rules a project of this kind can use. */
export function rulesFor(kind: SchemaKind): Array<PrelabelRule<PrelabelConfig>> {
  return (Object.values(PRELABEL_RULES) as Array<PrelabelRule<PrelabelConfig>>).filter((r) =>
    r.kinds.includes(kind),
  );
}

const anyConfig = z.discriminatedUnion('rule', [keywordsConfig, phrasesConfig]);

export type PrelabelParse =
  { ok: true; config: PrelabelConfig | null } | { ok: false; errors: string[] };

/**
 * Reads a project's rule settings from JSON text or a stored value. Empty
 * text means no rule. The rule has to fit the project's kind, and every label
 * or entity type it names has to be in the schema.
 */
export function parsePrelabel(input: unknown, schema: TaskSchema): PrelabelParse {
  let value = input;
  if (typeof input === 'string') {
    if (input.trim() === '') return { ok: true, config: null };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['The suggestion rule is not valid JSON'] };
    }
  }
  if (value === null || value === undefined) return { ok: true, config: null };
  const parsed = anyConfig.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      ),
    };
  }
  const rule = PRELABEL_RULES[parsed.data.rule] as PrelabelRule<PrelabelConfig>;
  if (!rule.kinds.includes(schema.kind)) {
    return { ok: false, errors: [`The ${rule.name} rule does not work for this kind of project`] };
  }
  const known =
    schema.kind === 'ner'
      ? schema.entities.map((e) => e.name)
      : 'labels' in schema
        ? schema.labels
        : [];
  const unknown = rule.names(parsed.data).filter((name) => !known.includes(name));
  if (unknown.length) return { ok: false, errors: [`Not in the schema: ${unknown.join(', ')}`] };
  return { ok: true, config: parsed.data };
}

/**
 * The suggestion a rule makes for one task, checked the way an annotator's
 * answer is. A rule that throws or returns something the schema refuses
 * suggests nothing.
 */
export function suggest(
  schema: TaskSchema,
  data: Record<string, unknown>,
  config: PrelabelConfig,
): Answer | null {
  const rule = PRELABEL_RULES[config.rule] as PrelabelRule<PrelabelConfig>;
  let raw: Answer | null;
  try {
    raw = rule.run(schema, data, config);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const checked = validateAnswer(schema, data, raw);
  return checked.ok ? checked.answer : null;
}

/**
 * A `_prediction` from an import file: the same short forms as `_gold`
 * ("label", "a|b", "A", "tie") or a full answer, checked against the schema.
 */
export function parsePrediction(
  schema: TaskSchema,
  data: Record<string, unknown>,
  raw: unknown,
): { ok: true; answer: Answer } | { ok: false; error: string } {
  return parseGold(schema, data, raw);
}

/** A suggestion in a few words, for the note above the interface. */
export function describeSuggestion(
  schema: TaskSchema,
  data: Record<string, unknown>,
  answer: Answer,
): string {
  switch (schema.kind) {
    case 'text_classification':
    case 'image_classification':
      return (answer as { labels: string[] }).labels.join(', ');
    case 'ner': {
      const text = String(data[schema.textField] ?? '');
      const spans = (answer as { spans: Array<{ start: number; end: number; label: string }> })
        .spans;
      return spans.length === 0
        ? 'no entities'
        : spans.map((s) => `${s.label} “${text.slice(s.start, s.end)}”`).join(', ');
    }
    case 'pairwise': {
      const preference = (answer as { preference: string }).preference;
      return preference === 'tie' ? 'about the same' : `response ${preference} is better`;
    }
    case 'bbox': {
      const boxes = (answer as { boxes: Array<{ label: string }> }).boxes;
      if (boxes.length === 0) return 'no boxes';
      const counts = new Map<string, number>();
      for (const b of boxes) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
      return [...counts].map(([label, n]) => `${n} ${label}`).join(', ');
    }
  }
}
