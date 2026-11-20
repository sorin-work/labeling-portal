/**
 * Colours the interfaces pick when the schema gives none. They are here and
 * not in the components so that `tests/unit/contrast.test.ts` can check them.
 */

/** Entity types without a colour of their own, in order. Shown at `ENTITY_TINT` over the text's background. */
export const ENTITY_COLORS = ['#f59e0b', '#6366f1', '#10b981', '#ef4444', '#0ea5e9', '#a855f7'];

/** The alpha, as two hex digits, that an entity colour is painted with behind the text. */
export const ENTITY_TINT = '55';

/** Box labels, in order. */
export const BOX_COLORS = [
  '#ef4444',
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
];
