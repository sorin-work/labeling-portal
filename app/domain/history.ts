/**
 * Undo and redo for one editor: the states before the present one, the
 * present, and the states that were undone. Pure, so any interface can keep
 * its own.
 */
export type History<T> = {
  past: T[];
  present: T;
  future: T[];
  /** what the last step was, so that a run of the same small step counts as one */
  tag: string | null;
};

/** Older steps than this are forgotten. */
export const HISTORY_LIMIT = 100;

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], tag: null };
}

/**
 * Records a new state. Steps with the same `tag` in a row are one step (a box
 * nudged twenty times with the arrow keys is undone at once); a step without
 * a tag always stands alone. Anything that was undone is gone after a new
 * step.
 */
export function commit<T>(history: History<T>, next: T, tag: string | null = null): History<T> {
  if (tag !== null && tag === history.tag) return { ...history, present: next, future: [] };
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    tag,
  };
}

/** Changes the present state without a step, for things undo should not see (the selection). */
export function amend<T>(history: History<T>, present: T): History<T> {
  return { ...history, present, tag: null };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past[history.past.length - 1],
    future: [history.present, ...history.future],
    tag: null,
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
    tag: null,
  };
}
