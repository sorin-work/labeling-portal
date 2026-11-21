import { describe, expect, it } from 'vitest';

import type { Span } from '~/domain/answers';
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
import { addSpan, describeSpanStep, relabelSpan, removeSpan } from '~/domain/spans';

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

describe('history of entity spans', () => {
  const text = 'Ada Lovelace was born in London.';
  const ada: Span = { start: 0, end: 12, label: 'PERSON' };
  const london: Span = { start: 25, end: 31, label: 'PLACE' };

  it('walks spans back and forth, the picked span with them', () => {
    let h = startHistory<{ spans: Span[]; picked: Pick<Span, 'start' | 'end'> | null }>({
      spans: [],
      picked: null,
    });
    h = commit(h, { spans: addSpan([], ada), picked: null });
    h = commit(h, { spans: addSpan(h.present.spans, london), picked: london });
    h = commit(h, { spans: relabelSpan(h.present.spans, london, 'ORG'), picked: london });
    h = commit(h, { spans: removeSpan(h.present.spans, ada), picked: london });
    expect(h.present.spans).toEqual([{ ...london, label: 'ORG' }]);

    h = undo(h);
    expect(h.present.spans).toEqual([ada, { ...london, label: 'ORG' }]);
    h = undo(h);
    expect(h.present).toEqual({ spans: [ada, london], picked: london });
    h = undo(h);
    h = undo(h);
    expect(h.present.spans).toEqual([]);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    expect(h.present.spans).toEqual([ada]);
  });

  it('says what came back, went or changed type', () => {
    expect(describeSpanStep(text, [ada], [], 'Undone')).toBe(
      'Undone, gone: PERSON “Ada Lovelace”. 0 spans.',
    );
    expect(describeSpanStep(text, [], [ada], 'Redone')).toBe(
      'Redone, back: PERSON “Ada Lovelace”. 1 span.',
    );
    expect(describeSpanStep(text, [{ ...ada, label: 'ORG' }], [ada, london], 'Undone')).toBe(
      'Undone, “Ada Lovelace” is PERSON, was ORG; back: PLACE “London”. 2 spans.',
    );
    expect(describeSpanStep(text, [ada], [ada], 'Undone')).toBe('Undone. 1 span.');
  });
});
