/**
 * Colour contrast as WCAG 2 measures it, for colours the way the stylesheet
 * writes them: `#rgb`, `#rrggbb`, `#rrggbbaa` and Tailwind's `oklch(L% C H)`.
 * jsdom has no layout and computes no colours, so the contrast check in
 * `tests/unit/contrast.test.ts` reads the palette and the class names and
 * works the ratios out here.
 */

/** Red, green and blue in 0..1 (sRGB, not linear), and the alpha. */
export type Rgba = { r: number; g: number; b: number; a: number };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function fromHex(hex: string): Rgba | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let digits = m[1];
  if (digits.length === 3) digits = [...digits].map((d) => d + d).join('');
  const part = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
  return { r: part(0), g: part(2), b: part(4), a: digits.length === 8 ? part(6) : 1 };
}

const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function fromOklch(css: string): Rgba | null {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css.trim());
  if (!m) return null;
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  // OKLab to linear sRGB (Björn Ottosson's matrices)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  // colours outside sRGB are clipped, as a screen shows them
  return { r: toGamma(clamp01(r)), g: toGamma(clamp01(g)), b: toGamma(clamp01(bl)), a: 1 };
}

/** Reads a colour, or null for anything this module does not understand. */
export function parseColor(css: string): Rgba | null {
  return fromHex(css) ?? fromOklch(css);
}

/** A colour with some transparency, painted over an opaque background. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance. */
export function luminance(color: Rgba): number {
  return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
}

/** WCAG contrast ratio, 1 to 21. A transparent foreground is painted over the background first. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = foreground.a < 1 ? over(foreground, background) : foreground;
  const [hi, lo] = [luminance(fg), luminance(background)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** What WCAG AA asks of text (1.4.3) and of controls, focus rings and other parts that carry meaning (1.4.11). */
export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;
