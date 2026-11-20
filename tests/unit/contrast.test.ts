import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AA_NON_TEXT,
  AA_TEXT,
  contrastRatio,
  over,
  parseColor,
  type Rgba,
} from '~/domain/contrast';
import { ENTITY_COLORS, ENTITY_TINT } from '~/domain/palette';

// ---------- the stylesheet ----------

/** Tailwind's palette, read from the theme the app's stylesheet imports. */
const palette = new Map<string, Rgba>();
for (const [, name, value] of readFileSync('node_modules/tailwindcss/theme.css', 'utf8').matchAll(
  /--color-([a-z]+(?:-\d+)?):\s*([^;]+);/g,
)) {
  const color = parseColor(value);
  if (color) palette.set(name, color);
}
const color = (name: string): Rgba => {
  const found = palette.get(name);
  if (!found) throw new Error(`no colour ${name} in the theme`);
  return found;
};

// ---------- the class names in the code ----------

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** Each quoted string in the code that holds a colour class, with where it is. */
const strings = sources('app').flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)]
    .map((m) => ({ file, text: m[2] }))
    .filter(({ text }) => /\b(?:text|bg)-(?:white|black|[a-z]+-\d{2,3})\b/.test(text)),
);

type ColorClass = { variant: string; name: string };
const classesOf = (text: string, kind: 'text' | 'bg'): ColorClass[] =>
  [
    ...text.matchAll(
      new RegExp(`(?:^|\\s)((?:[a-z-]+:)*)${kind}-(white|black|[a-z]+-\\d{2,3})(?=\\s|$)`, 'g'),
    ),
  ].map((m) => ({ variant: m[1], name: m[2] }));

/**
 * The surfaces text sits on when its own class string sets no background:
 * the page (`bg-slate-50` on `body`) and cards, tables and forms (white).
 */
const SURFACES = ['white', 'slate-50'];

/**
 * Text that sits on a background set further out, on a parent element, and
 * so not in its own class string. Keyed by the file and the text colour, so
 * an exception holds for that one use and not for the colour everywhere.
 */
const ON_PARENT: Array<{ file: string; text: string; on: string[]; where: string }> = [
  {
    file: 'app/components/labeling/text-classification.tsx',
    text: 'indigo-100',
    on: ['indigo-600'],
    where: 'the key cap on a chosen label',
  },
  {
    file: 'app/components/flash.tsx',
    text: 'slate-300',
    on: ['slate-900'],
    where: 'the button that closes the toast',
  },
  {
    file: 'app/components/flash.tsx',
    text: 'white',
    on: ['slate-900'],
    where: 'the same button when hovered',
  },
];

/** States WCAG does not ask contrast of: a control that cannot be used. */
const EXEMPT_VARIANTS = ['disabled:', 'aria-disabled:'];

type Pair = { text: string; bg: string; file: string; variant: string };

/**
 * Every text colour on the background it is drawn on, in every state a
 * class string names (hover, focus, ...). In a state, the text colour and the
 * background are the ones for that state when the string has them, and the
 * plain ones otherwise: a hover background without a hover text colour keeps
 * the plain text colour, and is checked with it.
 */
function pairs(): Pair[] {
  const found = new Map<string, Pair>();
  for (const { file, text } of strings) {
    const backgrounds = classesOf(text, 'bg');
    const colours = classesOf(text, 'text');
    const states = new Set(['', ...[...backgrounds, ...colours].map((c) => c.variant)]);
    for (const variant of states) {
      if (EXEMPT_VARIANTS.includes(variant)) continue;
      const pick = (list: ColorClass[]) => {
        const own = list.filter((c) => c.variant === variant);
        return (own.length > 0 ? own : list.filter((c) => c.variant === '')).map((c) => c.name);
      };
      const fgs = pick(colours);
      if (fgs.length === 0) continue; // the text colour comes from further out
      const bgs = pick(backgrounds);
      for (const fg of fgs) {
        const parent = ON_PARENT.find((p) => p.file === file && p.text === fg);
        const on = bgs.length > 0 ? bgs : (parent?.on ?? SURFACES);
        for (const bg of on) {
          found.set(`${variant}${fg} on ${bg} in ${file}`, { text: fg, bg, file, variant });
        }
      }
    }
  }
  return [...found.values()];
}

describe('colour contrast', () => {
  it('reads the palette and works ratios out the way WCAG does', () => {
    expect(contrastRatio(color('black'), color('white'))).toBeCloseTo(21, 5);
    // published values for Tailwind v4's slate on white
    expect(contrastRatio(color('slate-400'), color('white'))).toBeLessThan(3);
    expect(contrastRatio(color('slate-500'), color('white'))).toBeGreaterThan(4.5);
  });

  it('finds the class strings of the app', () => {
    expect(strings.length).toBeGreaterThan(100);
    expect(pairs().length).toBeGreaterThan(30);
    // a hover background with the plain text colour is checked: the danger button
    expect(pairs()).toContainEqual(
      expect.objectContaining({ variant: 'hover:', text: 'white', file: 'app/components/ui.tsx' }),
    );
  });

  it('gives every text colour on its background at least 4.5:1', () => {
    const failing = pairs()
      .map((p) => ({ ...p, ratio: contrastRatio(color(p.text), color(p.bg)) }))
      .filter((p) => p.ratio < AA_TEXT)
      .map((p) => `${p.variant}text-${p.text} on ${p.bg}: ${p.ratio.toFixed(2)} (${p.file})`);
    expect(failing).toEqual([]);
  });

  it('shows the focus ring at 3:1 or more on every surface', () => {
    // app.css: `outline: 2px solid var(--color-indigo-600)`
    for (const bg of [...SURFACES, 'slate-100']) {
      expect(contrastRatio(color('indigo-600'), color(bg))).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('keeps entity text readable on the default entity colours', () => {
    // a mark is the entity colour at ENTITY_TINT over the text box (slate-50);
    // its text is slate-900 and the type above it slate-600
    for (const hex of ENTITY_COLORS) {
      const mark = over(parseColor(`${hex}${ENTITY_TINT}`)!, color('slate-50'));
      expect(contrastRatio(color('slate-900'), mark)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrastRatio(color('slate-600'), mark), hex).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
