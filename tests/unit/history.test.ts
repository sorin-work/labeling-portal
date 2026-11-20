import { describe, expect, it } from 'vitest';

import {
  amend,
  canRedo,
  canUndo,
  commit,
  HISTORY_LIMIT,
  redo,
  startHistory,
  undo,
} from '~/domain/history';

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const history = startHistory('a');
    expect(history.present).toBe('a');
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it('walks back and forth through the steps', () => {
    let history = commit(commit(startHistory('a'), 'b'), 'c');
    history = undo(history);
    expect(history.present).toBe('b');
    history = undo(history);
    expect(history.present).toBe('a');
    expect(canUndo(history)).toBe(false);
    history = redo(redo(history));
    expect(history.present).toBe('c');
    expect(canRedo(history)).toBe(false);
  });

  it('forgets what was undone once something new happens', () => {
    let history = undo(commit(commit(startHistory('a'), 'b'), 'c'));
    history = commit(history, 'd');
    expect(canRedo(history)).toBe(false);
    expect(undo(history).present).toBe('b');
  });

  it('counts a run of the same small step as one', () => {
    let history = commit(startHistory(0), 1, 'nudge:0');
    history = commit(history, 2, 'nudge:0');
    history = commit(history, 3, 'nudge:0');
    expect(undo(history).present).toBe(0);
    // another box, or another kind of step, starts a new one
    history = commit(history, 4, 'nudge:1');
    history = commit(history, 5);
    history = commit(history, 6);
    expect(undo(history).present).toBe(5);
    expect(undo(undo(history)).present).toBe(4);
    expect(undo(undo(undo(history))).present).toBe(3);
  });

  it('does not merge into a step that was reached by undo or redo', () => {
    let history = commit(commit(startHistory(0), 1, 'nudge:0'), 2);
    history = undo(history);
    history = commit(history, 9, 'nudge:0');
    expect(undo(history).present).toBe(1);
  });

  it('changes the present without a step when asked to', () => {
    let history = commit(startHistory({ n: 0, selected: null as number | null }), {
      n: 1,
      selected: 0,
    });
    history = amend(history, { n: 1, selected: null });
    expect(history.present.selected).toBeNull();
    expect(history.past).toHaveLength(1);
    // and the next tagged step does not merge into what came before the change
    history = commit(
      amend(commit(history, { n: 2, selected: 0 }, 't'), history.present),
      {
        n: 3,
        selected: 0,
      },
      't',
    );
    expect(history.past).toHaveLength(3);
  });

  it('keeps a limited number of steps', () => {
    let history = startHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) history = commit(history, i);
    expect(history.past).toHaveLength(HISTORY_LIMIT);
    expect(history.past[0]).toBe(20);
  });
});
