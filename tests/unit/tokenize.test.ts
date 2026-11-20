import { describe, expect, it } from 'vitest';

import { bioTags, tokenize } from '~/domain/tokenize';

const tags = (text: string, spans: Array<[number, number, string]>) => {
  const tagged = bioTags(
    text,
    spans.map(([start, end, label]) => ({ start, end, label })),
  );
  return { ...tagged, tokens: tagged.tokens.map((t) => `${t.text}/${t.tag}`) };
};

describe('tokenize', () => {
  it('splits words and punctuation and keeps their offsets', () => {
    const text = 'Dr. O’Neil’s cat, in New-York!';
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.text)).toEqual([
      'Dr',
      '.',
      'O’Neil’s',
      'cat',
      ',',
      'in',
      'New',
      '-',
      'York',
      '!',
    ]);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });

  it('counts offsets in UTF-16 code units, like spans', () => {
    const text = 'Ada 👩‍🔬 met Zoë in Kraków.';
    const tokens = tokenize(text);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
    expect(tokens.map((t) => t.text)).toContain('Zoë');
    expect(tokens.map((t) => t.text)).toContain('Kraków');
    // a surrogate pair is one token, never half of one
    expect(tokens.every((t) => !/^[\uDC00-\uDFFF]/.test(t.text))).toBe(true);
  });

  it('gives nothing for text without a token', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' \n\t ')).toEqual([]);
  });
});

describe('bioTags', () => {
  const text = 'Ada Lovelace met Charles Babbage in London.';

  it('tags the first token of a span B and the rest I', () => {
    expect(
      tags(text, [
        [0, 12, 'PERSON'],
        [17, 32, 'PERSON'],
        [36, 42, 'LOCATION'],
      ]),
    ).toEqual({
      tokens: [
        'Ada/B-PERSON',
        'Lovelace/I-PERSON',
        'met/O',
        'Charles/B-PERSON',
        'Babbage/I-PERSON',
        'in/O',
        'London/B-LOCATION',
        './O',
      ],
      spans: 3,
      misaligned: 0,
    });
  });

  it('widens a span that covers half a word to the whole word, and counts it', () => {
    // "Lovel" and "ndon"
    expect(
      tags(text, [
        [4, 9, 'PERSON'],
        [38, 42, 'LOCATION'],
      ]),
    ).toMatchObject({
      tokens: expect.arrayContaining(['Ada/O', 'Lovelace/B-PERSON', 'London/B-LOCATION']),
      spans: 2,
      misaligned: 2,
    });
  });

  it('does not count a span that includes the space around whole tokens', () => {
    // "Ada Lovelace " with the trailing space: its edges are not token edges
    expect(tags(text, [[0, 13, 'PERSON']]).misaligned).toBe(1);
    expect(tags(text, [[0, 12, 'PERSON']]).misaligned).toBe(0);
  });

  it('keeps the first tag when two spans touch one token', () => {
    // "Love" and "lace" are two spans inside one word
    const tagged = tags(text, [
      [4, 8, 'PERSON'],
      [8, 12, 'ORG'],
    ]);
    expect(tagged.tokens[1]).toBe('Lovelace/B-PERSON');
    expect(tagged.misaligned).toBe(2);
  });

  it('counts a span that covers no token and tags nothing for it', () => {
    expect(tags('a  b', [[1, 3, 'X']])).toEqual({
      tokens: ['a/O', 'b/O'],
      spans: 1,
      misaligned: 1,
    });
    expect(tags('a b', [[40, 50, 'X']])).toMatchObject({ misaligned: 1 });
  });

  it('writes an entity type with a space in it as one tag', () => {
    expect(tags('Acme Corp', [[0, 9, 'Company name']]).tokens).toEqual([
      'Acme/B-Company_name',
      'Corp/I-Company_name',
    ]);
  });

  it('tags nothing without spans', () => {
    expect(tags('Just words.', [])).toEqual({
      tokens: ['Just/O', 'words/O', './O'],
      spans: 0,
      misaligned: 0,
    });
  });
});
