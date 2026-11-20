import { describe, expect, it } from 'vitest';

import {
  activeInterface,
  ANY_OTHER_KEY,
  DECISION_PAUSE_MS,
  decisionsOpen,
  hasReadOnlyKeys,
  helpSections,
  INTERFACE_KEYS,
  interfaceAction,
  interfaceKeys,
  interfaceKeysOn,
  interfaceShortcut,
  isNativeKey,
  isTextEntry,
  keyName,
  LABEL_KEYS,
  labelKeys,
  liveKeys,
  nextScoreGroup,
  pageAction,
  pageKeys,
  PAGES,
  pageShortcut,
  scoreGroups,
  scoreTarget,
  showKeys,
  type KeyContext,
  type Page,
} from '~/domain/hotkeys';
import { SCHEMA_TEMPLATES, type TaskSchema } from '~/domain/task-schema';

const names = (n: number) => Array.from({ length: n }, (_, i) => `label-${i + 1}`);

// every kind with as many labels as a schema may have
const SCHEMAS: TaskSchema[] = [
  { ...SCHEMA_TEMPLATES.text_classification, labels: names(30) },
  { ...SCHEMA_TEMPLATES.ner, entities: names(20).map((name) => ({ name })) },
  { ...SCHEMA_TEMPLATES.pairwise, allowTie: true },
  { ...SCHEMA_TEMPLATES.bbox, labels: names(30) },
  { ...SCHEMA_TEMPLATES.image_classification, labels: names(30) },
];
const [classification, , pairwise, boxes] = SCHEMAS;

const at = (page: Page | null, mode = '', more: Partial<KeyContext> = {}): KeyContext => ({
  page: page ? { name: page, mode } : null,
  dialog: false,
  typing: false,
  ...more,
});
const editing = (context: KeyContext) => ({ ...context, readOnly: false });

describe('label keys', () => {
  it('are 1 to 9, then 0, then letters', () => {
    expect(labelKeys(12)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'b', 'c']);
    expect(labelKeys(0)).toEqual([]);
  });

  it('reach 30 labels without a key twice and without the reserved letters', () => {
    const keys = labelKeys(30);
    expect(keys).toHaveLength(30);
    expect(new Set(keys).size).toBe(30);
    for (const reserved of ['a', 's', 'e', 'n', 'f', 'r']) expect(keys).not.toContain(reserved);
  });

  it('are cut to the labels of the project', () => {
    const three = { ...SCHEMA_TEMPLATES.text_classification, labels: names(3) };
    expect(interfaceKeys(three)[0].keys).toEqual(['1', '2', '3']);
    expect(interfaceAction(three, '4', editing(at(null)))).toBeNull();
    expect(interfaceAction(three, '3', editing(at(null)))).toEqual({ action: 'label', index: 2 });
    expect(interfaceAction(classification, 'b', editing(at(null)))).toEqual({
      action: 'label',
      index: 10,
    });
  });
});

describe('the key map', () => {
  const situations: Array<[string, KeyContext & { readOnly: boolean }]> = [
    ['a page without keys of its own', editing(at(null))],
    ['the work page', editing(at('work', 'labeling'))],
    ['the work page with the skip form open', editing(at('work', 'skipping'))],
    ['the review page, looking', { ...at('review', 'viewing'), readOnly: true }],
    ['the review page, about to approve', { ...at('review', 'approving'), readOnly: true }],
    ['the review page, fixing', editing(at('review', 'fixing'))],
    ['the open cheat sheet', editing(at('work', 'labeling', { dialog: true }))],
  ];

  it.each(situations)('gives no key two meanings on %s', (_name, context) => {
    for (const schema of SCHEMAS) {
      const keys = liveKeys(schema, context).map((k) => k.key);
      const twice = keys.filter((key, i) => keys.indexOf(key) !== i);
      expect(twice, schema.kind).toEqual([]);
    }
  });

  it('counts the keys of a read-only interface on the review page', () => {
    const viewing = { ...at('review', 'viewing'), readOnly: true };
    for (const schema of SCHEMAS) {
      const actions = liveKeys(schema, viewing).map((k) => k.action);
      expect(actions).not.toContain('label');
      expect(actions).not.toContain('remove');
      expect(actions).toContain('armApprove');
    }
    // a reviewer who only looks can zoom the image, and "f" is not a page key
    const live = liveKeys(boxes, viewing);
    expect(live.map((k) => k.action)).toEqual(expect.arrayContaining(['zoomIn', 'zoomOut', 'fit']));
    expect(live.filter((k) => k.key === 'f')).toEqual([{ key: 'f', action: 'fit' }]);
    expect(hasReadOnlyKeys(boxes)).toBe(true);
    expect(hasReadOnlyKeys(classification)).toBe(false);
  });

  it('lets a read-only box view look around and change nothing', () => {
    const looking = { ...at(null), readOnly: true };
    expect(interfaceAction(boxes, '+', looking)?.action).toBe('zoomIn');
    expect(interfaceAction(boxes, '=', looking)?.action).toBe('zoomIn');
    expect(interfaceAction(boxes, '-', looking)?.action).toBe('zoomOut');
    expect(interfaceAction(boxes, 'f', looking)?.action).toBe('fit');
    const edits = ['1', 'n', 'r', 'Delete', 'Backspace', 'ArrowLeft', 'Shift+ArrowUp', 'Mod+z'];
    for (const key of edits) expect(interfaceAction(boxes, key, looking), key).toBeNull();
    for (const key of edits) {
      expect(interfaceAction(boxes, key, editing(at('work', 'labeling'))), key).not.toBeNull();
    }
  });

  it('gives a box interface that the page holds back no keys at all', () => {
    const skipping = editing(at('work', 'skipping'));
    for (const key of ['+', 'f', 'n', 'ArrowLeft', 'Mod+z']) {
      expect(interfaceAction(boxes, key, skipping), key).toBeNull();
    }
  });

  it('repeats only the keys that are meant to be held', () => {
    const held = editing(at('work', 'labeling', { repeat: true }));
    expect(interfaceAction(boxes, 'ArrowRight', held)?.action).toBe('nudge');
    expect(interfaceAction(boxes, 'Shift+ArrowRight', held)?.action).toBe('nudgeFar');
    expect(interfaceAction(boxes, '+', held)?.action).toBe('zoomIn');
    for (const key of ['1', 'n', 'r', 'Delete', 'Mod+z', 'f']) {
      expect(interfaceAction(boxes, key, held), key).toBeNull();
    }
    expect(pageAction('s', at('work', 'labeling', { repeat: true }))).toBeNull();
    expect(pageAction('Mod+Enter', at('work', 'labeling', { repeat: true }))).toBeNull();
  });

  it('lists passive rows without acting on them', () => {
    const passive = interfaceKeys(boxes).filter((b) => b.passive);
    expect(passive.map((b) => b.action).sort()).toEqual(['cancelDrag', 'pan', 'select']);
    const context = editing(at('review', 'fixing'));
    // Escape cancels a drag inside the interface; in the key map it is the page's
    expect(interfaceAction(boxes, 'Escape', context)).toBeNull();
    expect(pageAction('Escape', context)).toBe('cancelFix');
    expect(interfaceAction(boxes, 'Tab', context)).toBeNull();
    expect(liveKeys(boxes, context).map((k) => k.key)).not.toContain('Tab');
  });

  it('names a mode that exists for every limited page key', () => {
    const modes: Record<Page, string[]> = {
      work: ['labeling', 'skipping'],
      review: ['viewing', 'approving', 'fixing'],
    };
    for (const page of Object.keys(PAGES) as Page[]) {
      expect(modes[page]).toContain(PAGES[page].labeling);
      for (const binding of PAGES[page].keys) {
        if (binding.when) expect(modes[page]).toContain(binding.when);
      }
    }
  });

  it('never puts an action that throws work away on a plain letter or digit', () => {
    const all = [
      ...pageKeys('work'),
      ...pageKeys('review'),
      ...Object.values(INTERFACE_KEYS).flat(),
    ];
    const destructive = all.filter((b) => b.destructive);
    expect(destructive.length).toBeGreaterThan(0);
    for (const binding of destructive) {
      expect(binding.keys.every((key) => key.length > 1)).toBe(true);
    }
    // skipping and releasing have no key that does it in one press
    expect(all.map((b) => b.action)).not.toContain('release');
    expect(pageAction('s', at('work', 'labeling'))).toBe('skip');
    expect(PAGES.work.keys.find((b) => b.action === 'skip')?.label).toMatch(/form/);
  });
});

describe('keys that commit', () => {
  const pages = Object.keys(PAGES) as Page[];
  const committing = pages.flatMap((page) =>
    PAGES[page].keys.filter((b) => b.commits).map((b) => ({ page, ...b })),
  );

  it('always name the one mode they belong to', () => {
    expect(committing.map((b) => b.action).sort()).toEqual(['approve', 'confirmSkip', 'submit']);
    for (const binding of committing) expect(binding.when, binding.action).toBeTruthy();
    // and a key that commits in two modes of a page commits something else in each
    for (const page of pages) {
      const seen = new Map<string, string>();
      for (const binding of committing.filter((b) => b.page === page)) {
        for (const key of binding.keys) {
          expect(seen.get(`${key}@${binding.when}`), `${key} twice in ${binding.when}`).toBe(
            undefined,
          );
          seen.set(`${key}@${binding.when}`, binding.action);
        }
      }
    }
  });

  it('make Ctrl+Enter hand in what the mode is about, never the task from the skip form', () => {
    for (const typing of [false, true]) {
      expect(pageAction('Mod+Enter', at('work', 'labeling', { typing }))).toBe('submit');
      expect(pageAction('Mod+Enter', at('work', 'skipping', { typing }))).toBe('confirmSkip');
    }
    // no mode of any page lets a key reach the task's submit except labeling
    for (const key of ['Mod+Enter', 'Enter', 'a', 's', '1', 'Escape', ' ']) {
      expect(pageAction(key, at('work', 'skipping')), key).not.toBe('submit');
    }
  });

  it('take two keys for a review decision: "a" arms, Enter approves', () => {
    const viewing = at('review', 'viewing');
    const approving = at('review', 'approving');
    expect(pageAction('a', viewing)).toBe('armApprove');
    expect(pageAction('Enter', viewing)).toBeNull();
    expect(pageAction('Enter', approving)).toBe('approve');
    expect(pageAction('Enter', at('review', 'fixing'))).toBeNull();
  });

  it('call the approval off on Escape and on any other key', () => {
    const approving = at('review', 'approving');
    for (const key of ['Escape', 'a', 's', 'e', '4', ' ', 'Tab', 'x', 'Mod+Enter']) {
      expect(pageAction(key, approving), key).toBe('disarm');
    }
    // also from a text box, where Enter is a new line and nothing more
    const typing = at('review', 'approving', { typing: true });
    expect(pageAction('x', typing)).toBe('disarm');
    expect(pageAction('Enter', typing)).toBe('disarm');
    // "?" still opens the list, and the page hears about it to call the approval off
    expect(pageAction('?', approving)).toBe('help');
    expect(ANY_OTHER_KEY).toBe('*');
  });

  it('wait until a new submission has been on screen before deciding by key', () => {
    expect(decisionsOpen(1_000, 1_000)).toBe(false);
    expect(decisionsOpen(1_000, 1_000 + DECISION_PAUSE_MS - 1)).toBe(false);
    expect(decisionsOpen(1_000, 1_000 + DECISION_PAUSE_MS)).toBe(true);
  });
});

describe('page keys', () => {
  it('lets "a" arm the approval while looking and pick response A while fixing', () => {
    const viewing = at('review', 'viewing');
    const fixing = at('review', 'fixing');
    expect(pageAction('a', viewing)).toBe('armApprove');
    expect(interfaceAction(pairwise, 'a', { ...viewing, readOnly: true })).toBeNull();
    expect(pageAction('a', fixing)).toBeNull();
    expect(interfaceAction(pairwise, 'a', editing(fixing))).toEqual({
      action: 'preferA',
      index: 0,
    });
  });

  it('gives the digits to the quality score while looking and to the rubric while fixing', () => {
    expect(pageAction('4', at('review', 'viewing'))).toBe('score');
    expect(pageAction('4', at('review', 'fixing'))).toBeNull();
    expect(interfaceAction(pairwise, '4', editing(at('review', 'fixing')))).toEqual({
      action: 'score',
      index: 3,
    });
  });

  it('starts and cancels a fix, and reaches the feedback box', () => {
    expect(pageAction('e', at('review', 'viewing'))).toBe('fix');
    expect(pageAction('s', at('review', 'viewing'))).toBe('feedback');
    expect(pageAction('Escape', at('review', 'viewing'))).toBeNull();
    expect(pageAction('Escape', at('review', 'fixing'))).toBe('cancelFix');
  });

  it('opens the skip form with "s" and closes it with Escape', () => {
    expect(pageAction('s', at('work', 'labeling'))).toBe('skip');
    expect(pageAction('Escape', at('work', 'labeling'))).toBeNull();
    expect(pageAction('s', at('work', 'skipping'))).toBeNull();
    expect(pageAction('Escape', at('work', 'skipping'))).toBe('closeSkip');
  });

  it('turns the interface keys off while the skip form is open', () => {
    expect(interfaceKeysOn(at('work', 'labeling'))).toBe(true);
    expect(interfaceKeysOn(at('work', 'skipping'))).toBe(false);
    expect(interfaceAction(classification, '1', editing(at('work', 'skipping')))).toBeNull();
    expect(interfaceAction(classification, '1', editing(at('work', 'labeling')))).not.toBeNull();
  });

  it('keeps out of text fields, except to submit or to close the skip form', () => {
    const typing = { typing: true };
    expect(pageAction('s', at('work', 'labeling', typing))).toBeNull();
    expect(pageAction('Mod+Enter', at('work', 'labeling', typing))).toBe('submit');
    expect(pageAction('Escape', at('work', 'skipping', typing))).toBe('closeSkip');
    expect(pageAction('a', at('review', 'viewing', typing))).toBeNull();
    expect(pageAction('Escape', at('review', 'fixing', typing))).toBeNull();
    expect(interfaceAction(pairwise, 'a', editing(at('work', 'labeling', typing)))).toBeNull();
  });

  it('leaves only its own keys to an open cheat sheet', () => {
    const open = at('work', 'labeling', { dialog: true });
    expect(pageAction('?', at('work', 'labeling'))).toBe('help');
    expect(pageAction('?', at(null))).toBe('help');
    expect(pageAction('?', open)).toBe('closeHelp');
    expect(pageAction('Escape', open)).toBe('closeHelp');
    expect(pageAction('Mod+Enter', open)).toBeNull();
    expect(pageAction('s', open)).toBeNull();
    expect(interfaceAction(classification, '1', editing(open))).toBeNull();
  });

  it('leaves "?" and Escape to the text box while the cheat sheet is open', () => {
    const typing = at('review', 'viewing', { dialog: true, typing: true });
    expect(pageAction('?', typing)).toBeNull();
    expect(pageAction('Escape', typing)).toBeNull();
    expect(pageAction('?', at('work', 'skipping', { dialog: true, typing: true }))).toBeNull();
    expect(pageAction('?', at(null, '', { typing: true }))).toBeNull();
  });

  it('has no tie key where ties are not allowed', () => {
    const noTie = { ...SCHEMA_TEMPLATES.pairwise, allowTie: false };
    expect(interfaceAction(noTie, 't', editing(at(null)))).toBeNull();
    expect(interfaceAction(pairwise, 't', editing(at(null)))?.action).toBe('preferTie');
  });
});

describe('keyName', () => {
  const press = (key: string, code: string, more = {}) => ({ key, code, ...more });

  it('takes a typed digit as it is, and reads the physical key when none was typed', () => {
    expect(keyName(press('1', 'Digit1'))).toBe('1');
    expect(keyName(press('&', 'Digit1'))).toBe('1'); // AZERTY without Shift
    expect(keyName(press('!', 'Digit1'))).toBe('1');
    expect(keyName(press('à', 'Digit0'))).toBe('0');
    // a layout with the digits in another order: the label the key shows wins
    expect(keyName(press('7', 'Digit1'))).toBe('7');
    expect(keyName(press('0', 'Digit9'))).toBe('0');
  });

  it('takes the number pad while Num Lock is on', () => {
    expect(keyName(press('7', 'Numpad7'))).toBe('7');
    expect(keyName(press('Home', 'Numpad7'))).toBe('Home');
    expect(keyName(press('ArrowDown', 'Numpad2'))).toBe('ArrowDown');
  });

  it('takes a symbol typed with Shift on a digit key as the symbol', () => {
    expect(keyName(press('?', 'Slash', { shiftKey: true }))).toBe('?');
    expect(keyName(press('?', 'Digit6', { shiftKey: true }))).toBe('?'); // Canadian French
    expect(keyName(press('+', 'Digit1', { shiftKey: true }))).toBe('+'); // Swiss
    expect(keyName(press('=', 'Digit0', { shiftKey: true }))).toBe('='); // German
    expect(keyName(press('+', 'Equal', { shiftKey: true }))).toBe('+');
    expect(keyName(press('-', 'Minus'))).toBe('-');
    expect(keyName(press('+', 'NumpadAdd'))).toBe('+');
    expect(keyName(press('-', 'NumpadSubtract'))).toBe('-');
    // AZERTY has "-" on the 6 key without Shift: there the digit wins
    expect(keyName(press('-', 'Digit6'))).toBe('6');
    expect(keyName(press('6', 'Digit6', { shiftKey: true }))).toBe('6');
  });

  it('writes Shift only for the arrow keys and Tab', () => {
    expect(keyName(press('ArrowLeft', 'ArrowLeft'))).toBe('ArrowLeft');
    expect(keyName(press('ArrowLeft', 'ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft');
    expect(keyName(press('Tab', 'Tab', { shiftKey: true }))).toBe('Shift+Tab');
    expect(keyName(press('Delete', 'Delete', { shiftKey: true }))).toBe('Delete');
    expect(keyName(press(' ', 'Space'))).toBe(' ');
  });

  it('lowers letters and keeps named keys', () => {
    expect(keyName(press('S', 'KeyS'))).toBe('s');
    expect(keyName(press('Delete', 'Delete'))).toBe('Delete');
    expect(keyName(press('Escape', 'Escape'))).toBe('Escape');
  });

  it('leaves Ctrl, Cmd and Alt combinations to the browser, except Ctrl or Cmd with Enter', () => {
    expect(keyName(press('1', 'Digit1', { ctrlKey: true }))).toBeNull();
    expect(keyName(press('s', 'KeyS', { metaKey: true }))).toBeNull();
    expect(keyName(press('s', 'KeyS', { altKey: true }))).toBeNull();
    expect(keyName(press('Enter', 'Enter', { ctrlKey: true }))).toBe('Mod+Enter');
    expect(keyName(press('Enter', 'Enter', { metaKey: true }))).toBe('Mod+Enter');
    expect(keyName(press('Enter', 'Enter', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(keyName(press('Enter', 'Enter'))).toBe('Enter');
    expect(keyName(press('z', 'KeyZ', { ctrlKey: true }))).toBe('Mod+z');
    expect(keyName(press('z', 'KeyZ', { metaKey: true }))).toBe('Mod+z');
    expect(keyName(press('y', 'KeyY', { ctrlKey: true }))).toBeNull();
  });

  it('does not take a modifier pressed on its own for a key', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']) {
      expect(keyName(press(key, `${key}Left`))).toBeNull();
    }
  });

  it('knows undo and redo, and no other Ctrl or Cmd letter', () => {
    expect(keyName(press('z', 'KeyZ', { ctrlKey: true }))).toBe('Mod+z');
    expect(keyName(press('z', 'KeyZ', { metaKey: true }))).toBe('Mod+z');
    expect(keyName(press('Z', 'KeyZ', { ctrlKey: true, shiftKey: true }))).toBe('Mod+Shift+z');
    expect(keyName(press('y', 'KeyY', { ctrlKey: true }))).toBeNull();
    expect(keyName(press('f', 'KeyF', { ctrlKey: true }))).toBeNull();
    expect(keyName(press('ArrowLeft', 'ArrowLeft', { altKey: true }))).toBeNull();
    expect(keyName(press('ArrowLeft', 'ArrowLeft', { ctrlKey: true }))).toBeNull();
    // in a text box Ctrl+Z stays the browser's own undo
    expect(interfaceAction(boxes, 'Mod+z', editing(at(null, '', { typing: true })))).toBeNull();
    expect(interfaceAction(boxes, 'Mod+z', editing(at(null)))?.action).toBe('undo');
    expect(interfaceAction(boxes, 'Mod+Shift+z', editing(at(null)))?.action).toBe('redo');
  });

  it('ignores text being composed', () => {
    expect(keyName(press('a', 'KeyA', { isComposing: true }))).toBeNull();
  });
});

describe('text entry', () => {
  it('is a text input, a textarea, a select or editable content', () => {
    expect(isTextEntry({ tag: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tag: 'INPUT', type: null })).toBe(true);
    expect(isTextEntry({ tag: 'input', type: 'number' })).toBe(true);
    expect(isTextEntry({ tag: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tag: 'SELECT' })).toBe(true);
    expect(isTextEntry({ tag: 'DIV', editable: true })).toBe(true);
  });

  it('is not a radio button, a checkbox, a button or the page itself', () => {
    expect(isTextEntry({ tag: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTextEntry({ tag: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tag: 'INPUT', type: 'submit' })).toBe(false);
    expect(isTextEntry({ tag: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tag: 'BODY' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it('leaves a focused control the keys it uses itself', () => {
    const radio = { tag: 'INPUT', type: 'radio' };
    expect(isNativeKey(radio, 'ArrowRight')).toBe(true);
    expect(isNativeKey(radio, ' ')).toBe(true);
    expect(isNativeKey(radio, '3')).toBe(false);
    expect(isNativeKey({ tag: 'INPUT', type: 'checkbox' }, ' ')).toBe(true);
    expect(isNativeKey({ tag: 'INPUT', type: 'checkbox' }, 'ArrowDown')).toBe(false);
    expect(isNativeKey({ tag: 'BUTTON' }, 'Enter')).toBe(true);
    expect(isNativeKey({ tag: 'BUTTON' }, 's')).toBe(false);
    expect(isNativeKey({ tag: 'BODY' }, 'Enter')).toBe(false);
    expect(isNativeKey(null, ' ')).toBe(false);
  });
});

describe('typing a pairwise rubric', () => {
  const groups = scoreGroups(['helpfulness', 'accuracy']);

  it('walks A then B for each dimension', () => {
    expect(groups).toEqual([
      { dimension: 'helpfulness', side: 'a' },
      { dimension: 'helpfulness', side: 'b' },
      { dimension: 'accuracy', side: 'a' },
      { dimension: 'accuracy', side: 'b' },
    ]);
    expect(nextScoreGroup(groups, groups[0])).toEqual(groups[1]);
    expect(nextScoreGroup(groups, groups[1])).toEqual(groups[2]);
    expect(nextScoreGroup(groups, groups[3])).toEqual(groups[3]);
  });

  it('scores the group that has focus', () => {
    const scores = { a: {}, b: {} };
    expect(scoreTarget(groups, { dimension: 'accuracy', side: 'a' }, scores)).toEqual(groups[2]);
    expect(scoreTarget(groups, { dimension: 'gone', side: 'a' }, scores)).toBeNull();
  });

  it('scores the first empty group when none has focus', () => {
    expect(scoreTarget(groups, null, { a: {}, b: {} })).toEqual(groups[0]);
    expect(scoreTarget(groups, null, { a: { helpfulness: 4 }, b: { helpfulness: 2 } })).toEqual(
      groups[2],
    );
    const full = { a: { helpfulness: 4, accuracy: 5 }, b: { helpfulness: 2, accuracy: 1 } };
    expect(scoreTarget(groups, null, full)).toBeNull();
  });
});

describe('several interfaces on one page', () => {
  it('gives the keys to the only interface without asking', () => {
    expect(activeInterface(['q1'], null)).toBe('q1');
    expect(activeInterface(['q1'], 'gone')).toBe('q1');
    expect(activeInterface([], 'q2')).toBeNull();
  });

  it('gives them to the card that was used last, and to none before that', () => {
    expect(activeInterface(['q1', 'q2', 'q3'], null)).toBeNull();
    expect(activeInterface(['q1', 'q2', 'q3'], 'q2')).toBe('q2');
    // the card that was in use is gone: nobody has the keys until one is clicked
    expect(activeInterface(['q1', 'q3'], 'q2')).toBeNull();
  });
});

describe('entity spans', () => {
  const ner = SCHEMAS[1];

  it('are removed with Delete only, never with Backspace', () => {
    expect(interfaceAction(ner, 'Delete', editing(at(null)))?.action).toBe('remove');
    expect(interfaceAction(ner, 'Backspace', editing(at(null)))).toBeNull();
  });

  it('can be put back with the undo key, which a text box keeps for itself', () => {
    expect(interfaceAction(ner, 'Mod+z', editing(at(null)))?.action).toBe('undoRemove');
    expect(interfaceAction(ner, 'Mod+z', editing(at(null, '', { typing: true })))).toBeNull();
  });

  it('are marked from the keyboard: arrows, Shift with the arrows, Enter', () => {
    const on = editing(at('work', 'labeling'));
    expect(interfaceAction(ner, 'ArrowRight', on)).toEqual({ action: 'cursor', index: 1 });
    expect(interfaceAction(ner, 'Shift+ArrowLeft', on)).toEqual({ action: 'extend', index: 0 });
    expect(interfaceAction(ner, 'Enter', on)?.action).toBe('mark');
    // held arrows walk on; Enter does not repeat
    expect(interfaceAction(ner, 'ArrowRight', { ...on, repeat: true })?.action).toBe('cursor');
    expect(interfaceAction(ner, 'Enter', { ...on, repeat: true })).toBeNull();
    // not while the skip form is open, and not in a read-only view
    expect(interfaceAction(ner, 'Enter', editing(at('work', 'skipping')))).toBeNull();
    expect(interfaceAction(ner, 'ArrowRight', { ...on, readOnly: true })).toBeNull();
    expect(interfaceShortcut(ner, ['cursor', 'extend'])).toBe('← / →, Shift + ← / Shift + →');
  });
});

describe('the cheat sheet', () => {
  it('prints keys the way people read them', () => {
    expect(showKeys(['Mod+Enter'])).toBe('Ctrl + Enter');
    expect(showKeys(['?', 'Escape'])).toBe('? / Esc');
    expect(showKeys(['Delete', 'Backspace'])).toBe('Delete / Backspace');
    expect(showKeys(labelKeys(5))).toBe('1 - 5');
    expect(showKeys(labelKeys(2))).toBe('1 / 2');
    expect(showKeys(labelKeys(10))).toBe('1 - 9, 0');
    expect(showKeys(labelKeys(14))).toBe('1 - 9, 0, then the letter on the label');
    expect(showKeys(LABEL_KEYS)).toBe('1 - 9, 0, then the letter on the label');
    expect(showKeys(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])).toBe('Arrows');
    expect(
      showKeys(['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown']),
    ).toBe('Shift + arrows');
    expect(showKeys(['Mod+z'])).toBe('Ctrl + Z');
    expect(showKeys(['Mod+Shift+z'])).toBe('Ctrl + Shift + Z');
    expect(showKeys(['Tab', 'Shift+Tab'])).toBe('Tab / Shift + Tab');
  });

  it('gives buttons the hint of their own row', () => {
    expect(pageShortcut('work', 'submit')).toBe('Ctrl + Enter');
    expect(pageShortcut('review', 'score')).toBe('1 - 5');
    expect(pageShortcut('review', 'armApprove')).toBe('a');
    expect(pageShortcut('review', 'approve')).toBe('Enter');
    expect(pageShortcut('review', 'disarm')).toBe('Esc / any other key');
    expect(pageShortcut('work', 'confirmSkip')).toBe('Ctrl + Enter');
    expect(interfaceShortcut(pairwise, ['preferA', 'preferB', 'preferTie'])).toBe('a, b, t');
    const noTie = { ...SCHEMA_TEMPLATES.pairwise, allowTie: false };
    expect(interfaceShortcut(noTie, ['preferA', 'preferB', 'preferTie'])).toBe('a, b');
  });

  it('lists every key of the page and the kind, and nothing else', () => {
    for (const page of ['work', 'review', null] as const) {
      for (const schema of SCHEMAS) {
        const rows = helpSections(page, schema).flatMap((section) => section.rows);
        const expected = [...pageKeys(page).filter((b) => !b.dialog), ...interfaceKeys(schema)];
        expect(rows.map((r) => r.label).sort()).toEqual(expected.map((b) => b.label).sort());
      }
    }
  });

  it('separates looking from fixing on the review page', () => {
    const [review, fixing] = helpSections('review', pairwise);
    expect(review.rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Get ready to approve: Enter then approves', 'After a: approve']),
    );
    expect(review.rows.map((r) => r.label)).not.toContain('A is better');
    expect(fixing.rows.map((r) => r.label)).toEqual(
      expect.arrayContaining(['Cancel the fix', 'A is better']),
    );
  });
});
