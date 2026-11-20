import { KIND_LABELS, type SchemaKind, type TaskSchema } from './task-schema';

/**
 * The one key map of the app. Every keyboard shortcut is a row in the tables
 * below: which page or labeling kind it belongs to, the action, the keys and
 * the words the cheat sheet shows. The key handlers, the cheat sheet behind
 * "?" and the hints next to buttons all read these tables, so they cannot
 * drift apart. New shortcuts are added here first; `tests/unit/hotkeys.test.ts`
 * fails when a key ends up with two meanings on one page.
 *
 * Key names: digits are '0' to '9', letters are lower case, other keys use
 * their `KeyboardEvent.key` name ('Delete', 'Escape', '?'), and 'Mod+Enter'
 * is Enter with Ctrl or Cmd.
 */

export type Page = 'work' | 'review';

export type KeyBinding = {
  action: string;
  keys: readonly string[];
  /** what the cheat sheet says the keys do */
  label: string;
  /** limited to one mode of its page (see `PAGES`); left out: every mode */
  when?: string;
  /** also works while the cursor is in a text field */
  typing?: boolean;
  /** belongs to the open cheat sheet; nothing else works while it is open */
  dialog?: boolean;
  /** throws work away: never on a plain letter or digit, see the tests */
  destructive?: boolean;
  /** interface keys: also works in a read-only view */
  readOnly?: boolean;
};

// ---------- label keys ----------

/**
 * Letters that mean something else somewhere and are therefore never a label
 * key: a, e and s are page keys, f and n are kept for the box interface (fit
 * to view, new box). Skipping them everywhere keeps a label on the same key on
 * every page.
 */
const NOT_LABEL_LETTERS = 'aefns';

/** 1 to 9, 0 for the tenth label, then the free letters. */
export const LABEL_KEYS: readonly string[] = [...'1234567890abcdefghijklmnopqrstuvwxyz'].filter(
  (key) => !NOT_LABEL_LETTERS.includes(key),
);

/** The keys for `count` labels, in label order. Labels past the last key have none. */
export function labelKeys(count: number): string[] {
  return LABEL_KEYS.slice(0, Math.max(0, count));
}

// ---------- the tables ----------

const HELP_KEYS: KeyBinding[] = [
  { action: 'help', keys: ['?'], label: 'Show this list' },
  { action: 'closeHelp', keys: ['?', 'Escape'], label: 'Close this list', dialog: true },
];

/**
 * Keys of a page. `labeling` names the mode in which the keys of the labeling
 * interface are on: while the skip form is open, or while a reviewer only
 * looks at a submission, the interface keys are off and the page may use the
 * same key for something else ("a" approves, and picks response A in a fix).
 */
export const PAGES: Record<Page, { labeling: string; keys: KeyBinding[] }> = {
  work: {
    labeling: 'labeling',
    keys: [
      {
        action: 'submit',
        keys: ['Mod+Enter'],
        label: 'Submit and go to the next task',
        typing: true,
      },
      { action: 'skip', keys: ['s'], label: 'Open the skip form', when: 'labeling' },
      {
        action: 'closeSkip',
        keys: ['Escape'],
        label: 'Close the skip form',
        when: 'skipping',
        typing: true,
      },
    ],
  },
  review: {
    labeling: 'fixing',
    keys: [
      {
        action: 'score',
        keys: ['1', '2', '3', '4', '5'],
        label: 'Set the quality score',
        when: 'viewing',
      },
      { action: 'approve', keys: ['a'], label: 'Approve', when: 'viewing' },
      {
        action: 'feedback',
        keys: ['s'],
        label: 'Go to the feedback box, to send the work back',
        when: 'viewing',
      },
      { action: 'fix', keys: ['e'], label: 'Fix it myself', when: 'viewing' },
      { action: 'cancelFix', keys: ['Escape'], label: 'Cancel the fix', when: 'fixing' },
    ],
  },
};

/** Keys of each labeling interface. The label keys are cut to the project's labels. */
export const INTERFACE_KEYS: Record<SchemaKind, KeyBinding[]> = {
  text_classification: [{ action: 'label', keys: LABEL_KEYS, label: 'Pick a label' }],
  ner: [
    {
      action: 'label',
      keys: LABEL_KEYS,
      label: 'Choose the entity type, or change the type of the selected span',
    },
    {
      action: 'remove',
      keys: ['Delete', 'Backspace'],
      label: 'Remove the selected span',
      destructive: true,
    },
  ],
  pairwise: [
    {
      action: 'score',
      keys: ['1', '2', '3', '4', '5'],
      label: 'Score the row that has focus, or the first empty one, and move on',
    },
    { action: 'preferA', keys: ['a'], label: 'A is better' },
    { action: 'preferB', keys: ['b'], label: 'B is better' },
    { action: 'preferTie', keys: ['t'], label: 'About the same' },
  ],
  bbox: [
    {
      action: 'label',
      keys: LABEL_KEYS,
      label: 'Choose the box label, or relabel the selected box',
    },
    {
      action: 'remove',
      keys: ['Delete', 'Backspace'],
      label: 'Remove the selected box',
      destructive: true,
    },
  ],
};

/** The keys of a page, with the cheat sheet's own. Pages without keys still have "?". */
export function pageKeys(page: Page | null): KeyBinding[] {
  return [...(page ? PAGES[page].keys : []), ...HELP_KEYS];
}

function labelCount(schema: TaskSchema): number {
  switch (schema.kind) {
    case 'text_classification':
    case 'bbox':
      return schema.labels.length;
    case 'ner':
      return schema.entities.length;
    case 'pairwise':
      return 0;
  }
}

/** The interface keys for one project: as many label keys as it has labels, no tie key without ties. */
export function interfaceKeys(schema: TaskSchema): KeyBinding[] {
  return INTERFACE_KEYS[schema.kind]
    .filter((b) => b.action !== 'preferTie' || (schema.kind === 'pairwise' && schema.allowTie))
    .map((b) => (b.action === 'label' ? { ...b, keys: labelKeys(labelCount(schema)) } : b));
}

// ---------- from a key press to an action ----------

export type KeyPress = {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
};

/**
 * The name a key press has in the key map, or null when it is not for the
 * app: a key that is held down, text being composed, or anything with Ctrl,
 * Cmd or Alt, which belong to the browser and to screen readers. Only Ctrl or
 * Cmd with Enter is ours.
 *
 * Digits are read from the physical key, so the digit row works on layouts
 * where it needs Shift (AZERTY), and so does the number pad while Num Lock is
 * on. "?" is taken as typed, because some layouts have it on a digit key.
 */
export function keyName(press: KeyPress): string | null {
  if (press.repeat || press.isComposing || press.altKey) return null;
  if (press.ctrlKey || press.metaKey) return press.key === 'Enter' ? 'Mod+Enter' : null;
  if (press.key === '?') return '?';
  const digit = /^Digit(\d)$/.exec(press.code);
  if (digit) return digit[1];
  return press.key.length === 1 ? press.key.toLowerCase() : press.key;
}

/** What the key handler needs to know about the element that has focus. */
export type FocusTarget = { tag: string; type?: string | null; editable?: boolean };

const INPUTS_WITHOUT_TEXT = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'image',
  'file',
  'range',
  'color',
];

/**
 * True when typing goes into the element: text inputs, textareas, selects and
 * editable content. A focused radio button or checkbox is not text entry, so
 * shortcuts keep working there.
 */
export function isTextEntry(target: FocusTarget | null): boolean {
  if (!target) return false;
  if (target.editable) return true;
  const tag = target.tag.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !INPUTS_WITHOUT_TEXT.includes((target.type ?? 'text').toLowerCase());
}

const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/**
 * Keys that the focused control uses itself and that a shortcut must never
 * take away: the arrows and Space in a radio group, Space on a checkbox,
 * Enter and Space on a button or link.
 */
export function isNativeKey(target: FocusTarget | null, key: string): boolean {
  if (!target) return false;
  const tag = target.tag.toUpperCase();
  const type = (target.type ?? '').toLowerCase();
  if (tag === 'INPUT' && (type === 'radio' || type === 'range')) {
    return ARROWS.includes(key) || key === ' ';
  }
  if (tag === 'INPUT' && type === 'checkbox') return key === ' ';
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return key === 'Enter' || key === ' ';
  return false;
}

export type KeyContext = {
  /** the page's keys and the mode it is in; null on a page without keys of its own */
  page: { name: Page; mode: string } | null;
  /** the cheat sheet is open */
  dialog: boolean;
  /** the cursor is in a text field */
  typing: boolean;
};

function isLive(binding: KeyBinding, context: KeyContext): boolean {
  if (context.dialog) return binding.dialog === true;
  if (binding.dialog) return false;
  if (context.typing && !binding.typing) return false;
  return binding.when === undefined || binding.when === context.page?.mode;
}

function livePageKeys(context: KeyContext): KeyBinding[] {
  return pageKeys(context.page?.name ?? null).filter((b) => isLive(b, context));
}

/** True while the page lets the labeling interface have its keys. */
export function interfaceKeysOn(context: KeyContext): boolean {
  if (context.dialog || context.typing) return false;
  return !context.page || PAGES[context.page.name].labeling === context.page.mode;
}

type InterfaceContext = KeyContext & { readOnly: boolean };

function liveInterfaceKeys(schema: TaskSchema, context: InterfaceContext): KeyBinding[] {
  if (context.dialog || context.typing) return [];
  const editing = !context.readOnly && interfaceKeysOn(context);
  return interfaceKeys(schema).filter((b) => editing || b.readOnly);
}

/** The page action a key stands for right now, or null. */
export function pageAction(key: string, context: KeyContext): string | null {
  return livePageKeys(context).find((b) => b.keys.includes(key))?.action ?? null;
}

/** `index` is the position of the key in its row: the label, or the score minus one. */
export type InterfaceHit = { action: string; index: number };

/** The interface action a key stands for right now, or null. */
export function interfaceAction(
  schema: TaskSchema,
  key: string,
  context: InterfaceContext,
): InterfaceHit | null {
  for (const binding of liveInterfaceKeys(schema, context)) {
    const index = binding.keys.indexOf(key);
    if (index >= 0) return { action: binding.action, index };
  }
  return null;
}

/**
 * Every key that does something in one situation, page and interface
 * together. A key that shows up twice here has two meanings at once.
 */
export function liveKeys(
  schema: TaskSchema,
  context: InterfaceContext,
): Array<{ key: string; action: string }> {
  return [...livePageKeys(context), ...liveInterfaceKeys(schema, context)].flatMap((b) =>
    b.keys.map((key) => ({ key, action: b.action })),
  );
}

/**
 * With several interfaces on one page (the qualification test), keys go to
 * one of them: the one that was used last, or the first while none was.
 */
export function activeInterface<T>(mounted: readonly T[], lastUsed: T | null): T | null {
  if (lastUsed !== null && mounted.includes(lastUsed)) return lastUsed;
  return mounted[0] ?? null;
}

// ---------- pairwise: typing the rubric ----------

export type ScoreGroup = { dimension: string; side: 'a' | 'b' };
type Scores = { a: Record<string, number>; b: Record<string, number> };

/** The order in which typed scores fill the rubric: A, then B, for each dimension. */
export function scoreGroups(dimensions: readonly string[]): ScoreGroup[] {
  return dimensions.flatMap((dimension) => [
    { dimension, side: 'a' as const },
    { dimension, side: 'b' as const },
  ]);
}

const sameGroup = (a: ScoreGroup, b: ScoreGroup) =>
  a.dimension === b.dimension && a.side === b.side;

/** Where a typed score goes: the group that has focus, else the first one without a score. */
export function scoreTarget(
  groups: readonly ScoreGroup[],
  focused: ScoreGroup | null,
  scores: Scores,
): ScoreGroup | null {
  if (focused) return groups.find((g) => sameGroup(g, focused)) ?? null;
  return groups.find((g) => scores[g.side][g.dimension] === undefined) ?? null;
}

/** The group that takes focus after a score was typed. The last one keeps it. */
export function nextScoreGroup(groups: readonly ScoreGroup[], current: ScoreGroup): ScoreGroup {
  const index = groups.findIndex((g) => sameGroup(g, current));
  return groups[index + 1] ?? current;
}

// ---------- showing keys ----------

const KEY_WORDS: Record<string, string> = { 'Mod+Enter': 'Ctrl + Enter', Escape: 'Esc' };

/** Keys the way the cheat sheet and the hints print them. */
export function showKeys(keys: readonly string[]): string {
  const labels = keys.length > 0 && keys.every((key, i) => key === LABEL_KEYS[i]);
  if (labels && keys.length > 10) return '1 - 9, 0, then the letter on the label';
  if (labels && keys.length === 10) return '1 - 9, 0';
  if (labels && keys.length > 2) return `1 - ${keys.length}`;
  return keys.map((key) => KEY_WORDS[key] ?? key).join(' / ');
}

/** The keys of a page action, for the hint next to its button. */
export function pageShortcut(page: Page, action: string): string {
  return showKeys(PAGES[page].keys.find((b) => b.action === action)?.keys ?? []);
}

/** The keys of some interface actions of a project, for the hint next to the controls. */
export function interfaceShortcut(schema: TaskSchema, actions: string[]): string {
  return interfaceKeys(schema)
    .filter((b) => actions.includes(b.action))
    .map((b) => showKeys(b.keys))
    .join(', ');
}

export type HelpSection = { title: string; rows: Array<{ keys: string; label: string }> };

/** The cheat sheet for a page and a project, straight from the tables. */
export function helpSections(page: Page | null, schema: TaskSchema): HelpSection[] {
  const row = (b: KeyBinding) => ({ keys: showKeys(b.keys), label: b.label });
  const interfaceRows = interfaceKeys(schema)
    .filter((b) => b.keys.length > 0)
    .map(row);
  const own = pageKeys(page).filter((b) => !b.dialog);
  const kind = KIND_LABELS[schema.kind];

  if (page === 'review') {
    const fixing = PAGES.review.labeling;
    return [
      { title: 'Review', rows: own.filter((b) => b.when !== fixing).map(row) },
      {
        title: `While fixing: ${kind.toLowerCase()}`,
        rows: [...own.filter((b) => b.when === fixing).map(row), ...interfaceRows],
      },
    ];
  }
  return [
    { title: kind, rows: interfaceRows },
    { title: page === 'work' ? 'Task' : 'This page', rows: own.map(row) },
  ];
}
