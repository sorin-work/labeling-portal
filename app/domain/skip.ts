/** The reasons an annotator can give for skipping a task, in the order the form lists them. */
export const SKIP_REASONS = [
  'Instructions do not cover this case',
  'Content is broken or unreadable',
  'Content is offensive or disturbing',
  'Not in a language I can label',
  'Other',
];

/** The reason to give for an image that does not load. */
export const SKIP_BROKEN = SKIP_REASONS[1];
