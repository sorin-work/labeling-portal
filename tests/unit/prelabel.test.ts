import { describe, expect, it } from 'vitest';

import {
  MAX_SCAN,
  MAX_TERMS,
  parsePrediction,
  parsePrelabel,
  rulesFor,
  suggest,
  type PrelabelConfig,
} from '~/domain/prelabel';
import { SCHEMA_TEMPLATES } from '~/domain/task-schema';

const sentiment = SCHEMA_TEMPLATES.text_classification;
const ner = SCHEMA_TEMPLATES.ner;

const keywords = (labels: Record<string, string[]>): PrelabelConfig => ({
  rule: 'keywords',
  labels,
});
const phrases = (entities: Record<string, string[]>): PrelabelConfig => ({
  rule: 'phrases',
  entities,
});

describe('keyword rule', () => {
  const config = keywords({ positive: ['great', 'love it'], negative: ['broken', 'refund'] });

  it('suggests the label whose words are in the text, as whole words', () => {
    expect(suggest(sentiment, { text: 'Great value, I love it!' }, config)).toEqual({
      labels: ['positive'],
    });
    // "greater" is not "great"
    expect(suggest(sentiment, { text: 'Greater than expected' }, config)).toBeNull();
    expect(suggest(sentiment, { text: 'Nothing to say' }, config)).toBeNull();
  });

  it('takes the label with the most hits, the earlier one on a tie', () => {
    expect(suggest(sentiment, { text: 'great but broken, broken' }, config)).toEqual({
      labels: ['negative'],
    });
    expect(suggest(sentiment, { text: 'great but broken' }, config)).toEqual({
      labels: ['positive'],
    });
  });

  it('suggests every label that hits on a multi-label project', () => {
    expect(suggest({ ...sentiment, multiple: true }, { text: 'great but broken' }, config)).toEqual(
      { labels: ['positive', 'negative'] },
    );
  });
});

describe('phrase rule', () => {
  const config = phrases({
    PERSON: ['Ada', 'Ada Lovelace'],
    LOCATION: ['London', 'New York'],
    ORG: ['York University'],
  });

  it('marks whole-word phrases, the longest first, never overlapping', () => {
    const text = 'Ada Lovelace met Ada in London and New York University.';
    expect(suggest(ner, { text }, config)).toEqual({
      spans: [
        { start: 0, end: 12, label: 'PERSON' },
        { start: 17, end: 20, label: 'PERSON' },
        { start: 24, end: 30, label: 'LOCATION' },
        // "York University" is longer than "New York" and wins the overlap
        { start: 39, end: 54, label: 'ORG' },
      ],
    });
  });

  it('reads only the first part of a very long text', () => {
    const text = `${'x '.repeat(MAX_SCAN / 2)} London`;
    expect(suggest(ner, { text }, config)).toBeNull();
  });
});

describe('rule settings', () => {
  it('are refused when they name labels the schema does not have', () => {
    expect(parsePrelabel(keywords({ happy: ['yay'] }), sentiment)).toEqual({
      ok: false,
      errors: ['Not in the schema: happy'],
    });
  });

  it('must fit the kind of project', () => {
    expect(parsePrelabel(phrases({ PERSON: ['Ada'] }), sentiment)).toMatchObject({ ok: false });
    expect(rulesFor('ner').map((r) => r.name)).toEqual(['phrases']);
    expect(rulesFor('text_classification').map((r) => r.name)).toEqual(['keywords']);
    expect(rulesFor('bbox')).toEqual([]);
  });

  it('cap the number and the length of words and phrases', () => {
    const many = Array.from({ length: MAX_TERMS + 1 }, (_, i) => `w${i}`);
    expect(parsePrelabel(keywords({ positive: many }), sentiment)).toMatchObject({ ok: false });
    expect(parsePrelabel(keywords({ positive: ['x'.repeat(101)] }), sentiment)).toMatchObject({
      ok: false,
    });
    expect(parsePrelabel(keywords({ positive: [' '] }), sentiment)).toMatchObject({ ok: false });
  });

  it('take JSON text, and empty text means no rule', () => {
    expect(parsePrelabel('', sentiment)).toEqual({ ok: true, config: null });
    expect(parsePrelabel('{', sentiment)).toMatchObject({ ok: false });
    expect(parsePrelabel('{"rule":"keywords","labels":{"positive":["good"]}}', sentiment)).toEqual({
      ok: true,
      config: { rule: 'keywords', labels: { positive: ['good'] } },
    });
    // a rule that is not in the registry
    expect(parsePrelabel({ rule: 'model', url: 'http://x' }, sentiment)).toMatchObject({
      ok: false,
    });
  });
});

describe('suggestions are answers the schema accepts, or nothing', () => {
  it('drops a suggestion the validator refuses', () => {
    // a single-label project never gets two labels, even from a file
    expect(parsePrediction(sentiment, {}, 'positive|negative')).toMatchObject({ ok: false });
    expect(parsePrediction(sentiment, {}, 'positive')).toEqual({
      ok: true,
      answer: { labels: ['positive'] },
    });
    expect(parsePrediction(SCHEMA_TEMPLATES.pairwise, {}, 'B')).toMatchObject({
      ok: true,
      answer: { preference: 'B' },
    });
  });
});
