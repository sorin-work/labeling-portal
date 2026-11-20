import type { Span } from './answers';

/** A piece of text with where it sits, in UTF-16 code units like a span. */
export type Token = { text: string; start: number; end: number };

/**
 * A word (letters, digits and marks, with an apostrophe inside it allowed) or
 * one other character that is not white space. So "Dr. O'Neil's cat." is
 * Dr, ., O'Neil's, cat and . again.
 */
const TOKEN = /[\p{L}\p{N}\p{M}_]+(?:['’][\p{L}\p{N}\p{M}_]+)*|[^\s\p{L}\p{N}\p{M}_]/gu;

/** Splits text into tokens, keeping the offsets. White space separates and is dropped. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export type TaggedText = {
  tokens: Array<{ text: string; tag: string }>;
  /** spans that were given */
  spans: number;
  /** spans whose edges were not token edges, or that covered no token at all */
  misaligned: number;
};

/** An entity type as a tag: no white space, which would split the line. */
function tagName(label: string): string {
  return label.trim().replace(/\s+/g, '_');
}

/**
 * BIO tags for a text: B-TYPE on the first token of an entity, I-TYPE on the
 * rest of it, O elsewhere. Spans are character offsets and need not line up
 * with tokens: someone can select half a word. Every token a span touches
 * gets the span's tag, which widens such a span to whole tokens, and those
 * spans are counted. A token two spans touch keeps the tag of the first.
 */
export function bioTags(text: string, spans: Span[]): TaggedText {
  const tokens = tokenize(text);
  const tags = tokens.map(() => 'O');
  let misaligned = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const touched: number[] = [];
    tokens.forEach((token, i) => {
      if (token.start < span.end && token.end > span.start) touched.push(i);
    });
    const aligned =
      touched.length > 0 &&
      tokens[touched[0]].start === span.start &&
      tokens[touched[touched.length - 1]].end === span.end;
    if (!aligned) misaligned += 1;
    let first = true;
    for (const i of touched) {
      if (tags[i] !== 'O') continue;
      tags[i] = `${first ? 'B' : 'I'}-${tagName(span.label)}`;
      first = false;
    }
  }
  return {
    tokens: tokens.map((token, i) => ({ text: token.text, tag: tags[i] })),
    spans: spans.length,
    misaligned,
  };
}
