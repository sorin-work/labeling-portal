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
 * their `KeyboardEvent.key` name ('Delete', 'Escape', '?', 'ArrowLeft').
 * 'Mod+' is Ctrl or Cmd, and only 'Mod+Enter', 'Mod+z', 'Mod+Shift+z' and
 * 'Mod+y' exist. 'Shift+' is only written for the arrow keys and Tab; elsewhere Shift
 * is part of typing the character. '*' stands for any other key.
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
  /**
   * Hands something in for good: a task, a skip, a review decision. Such a
   * key must name the one mode it belongs to (`when`), so that it can never
   * commit something else than what is on the screen.
   */
  commits?: boolean;
  /** interface keys: also works in a read-only view */
  readOnly?: boolean;
  /** keeps acting while the key is held down (moving a box, zooming) */
  repeat?: boolean;
  /**
   * Listed in the cheat sheet but not handled through the key map: the browser
   * does it (Tab), or it only means something while the pointer is down.
   */
  passive?: boolean;
};

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

// ---------- label keys ----------

/**
 * Letters that mean something else somewhere and are therefore never a label
 * key: a, e and s are page keys; f, n and r belong to the box interface (fit
 * to view, new box, resize). Skipping them everywhere keeps a label on the
 * same key on every page.
 */
const NOT_LABEL_LETTERS = 'aefnrs';

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

/** In a row's keys: every key that no other live row of the page takes. */
export const ANY_OTHER_KEY = '*';

/**
 * After a review decision the next submission loads on the same page. Keys
 * that decide are ignored until it has been on screen this long, so a key
 * that is still held or pressed twice cannot decide on work nobody has seen.
 */
export const DECISION_PAUSE_MS = 800;

export function decisionsOpen(shownAt: number, now: number): boolean {
  return now - shownAt >= DECISION_PAUSE_MS;
}

/**
 * Keys of a page. `labeling` names the mode in which the keys of the labeling
 * interface are on: while the skip form is open, or while a reviewer only
 * looks at a submission, the interface keys are off and the page may use the
 * same key for something else ("a" is for approving, and picks response A in
 * a fix).
 *
 * Ctrl or Cmd with Enter always commits what the current mode is about: the
 * task while labeling, the skip while the skip form is open. A review
 * decision takes two keys: "a" only arms the approval and Enter records it.
 */
export const PAGES: Record<Page, { labeling: string; keys: KeyBinding[] }> = {
  work: {
    labeling: 'labeling',
    keys: [
      {
        action: 'submit',
        keys: ['Mod+Enter'],
        label: 'Submit and go to the next task',
        when: 'labeling',
        typing: true,
        commits: true,
      },
      { action: 'skip', keys: ['s'], label: 'Open the skip form', when: 'labeling' },
      {
        action: 'confirmSkip',
        keys: ['Mod+Enter'],
        label: 'In the skip form: skip the task',
        when: 'skipping',
        typing: true,
        commits: true,
      },
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
      {
        action: 'armApprove',
        keys: ['a'],
        label: 'Get ready to approve: Enter then approves',
        when: 'viewing',
      },
      {
        action: 'approve',
        keys: ['Enter'],
        label: 'After a: approve',
        when: 'approving',
        commits: true,
      },
      {
        action: 'disarm',
        keys: ['Escape', ANY_OTHER_KEY],
        label: 'After a: do not approve',
        when: 'approving',
        typing: true,
      },
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
  image_classification: [{ action: 'label', keys: LABEL_KEYS, label: 'Pick a label' }],
  ner: [
    {
      action: 'label',
      keys: LABEL_KEYS,
      label: 'Choose the entity type, or change the type of the selected span',
    },
    // Not Backspace: a reviewer who clicks a span leaves the feedback box, and
    // the next Backspace is meant for text.
    { action: 'remove', keys: ['Delete'], label: 'Remove the selected span', destructive: true },
    { action: 'undo', keys: ['Mod+z'], label: 'Undo' },
    { action: 'redo', keys: ['Mod+Shift+z', 'Mod+y'], label: 'Redo' },
    // The text keys only act while the text has focus (Tab to it); anywhere
    // else the arrows and Enter keep what they do.
    {
      action: 'cursor',
      keys: ['ArrowLeft', 'ArrowRight'],
      label: 'In the text: go to the previous or the next word',
      repeat: true,
    },
    {
      action: 'extend',
      keys: ['Shift+ArrowLeft', 'Shift+ArrowRight'],
      label: 'In the text: select one word more or less',
      repeat: true,
    },
    {
      action: 'mark',
      keys: ['Enter'],
      label: 'In the text: mark the selected words as the entity type',
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
    { action: 'new', keys: ['n'], label: 'Put a new box in the middle of the view' },
    {
      action: 'select',
      keys: ['Tab', 'Shift+Tab'],
      label: 'Go to the next or the previous box',
      passive: true,
    },
    {
      action: 'nudge',
      keys: ARROWS,
      label: 'Move the box that has focus by one pixel',
      repeat: true,
    },
    {
      action: 'nudgeFar',
      keys: ARROWS.map((key) => `Shift+${key}`),
      label: 'Move it by ten pixels',
      repeat: true,
    },
    {
      action: 'resizeMode',
      keys: ['r'],
      label: 'Make the arrows resize the box instead of moving it, and back',
    },
    {
      action: 'remove',
      keys: ['Delete', 'Backspace'],
      label: 'Remove the selected box',
      destructive: true,
    },
    { action: 'undo', keys: ['Mod+z'], label: 'Undo' },
    { action: 'redo', keys: ['Mod+Shift+z', 'Mod+y'], label: 'Redo' },
    { action: 'zoomIn', keys: ['+', '='], label: 'Zoom in', readOnly: true, repeat: true },
    { action: 'zoomOut', keys: ['-'], label: 'Zoom out', readOnly: true, repeat: true },
    { action: 'fit', keys: ['f'], label: 'Fit the whole image', readOnly: true },
    {
      action: 'pan',
      keys: ['Space'],
      label: 'Hold and drag to move a zoomed view',
      readOnly: true,
      passive: true,
    },
    {
      action: 'cancelDrag',
      keys: ['Escape'],
      label: 'While dragging: put the box back',
      passive: true,
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
    case 'image_classification':
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

/** True when a read-only interface of this kind still has keys (to look around, not to edit). */
export function hasReadOnlyKeys(schema: TaskSchema): boolean {
  return INTERFACE_KEYS[schema.kind].some((b) => b.readOnly && !b.passive);
}

// ---------- from a key press to an action ----------

export type KeyPress = {
  key: string;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

/** Pressed on their own they are not a key press for the map. */
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'OS'];

/** Characters the key map uses as themselves. On some layouts they are Shift with a digit key. */
const SYMBOL_KEYS = ['?', '+', '-', '='];

/**
 * The name a key press has in the key map, or null when it is not for the
 * app: a modifier on its own, text being composed, or anything with Ctrl, Cmd
 * or Alt, which belong to the browser and to screen readers. The exceptions
 * are Ctrl or Cmd with Enter (hand in) and with Z (undo, redo with Shift),
 * which the browser only uses inside text boxes, and there the key map leaves
 * them alone.
 *
 * A digit is taken as typed, so a layout with its digits in another order
 * gets the label it shows. Only when the key did not type a digit is the
 * physical key read: that makes the digit row work on layouts where it needs
 * Shift (AZERTY). The number pad types digits while Num Lock is on. A symbol
 * the map uses wins when it is typed with Shift on a digit key ("?" on
 * Shift+6, "+" on Shift+1). Without Shift the digit wins, which costs AZERTY
 * its "-" on the 6 key; the number pad has another.
 */
export function keyName(press: KeyPress): string | null {
  if (press.isComposing || press.altKey) return null;
  if (MODIFIER_KEYS.includes(press.key)) return null;
  if (press.ctrlKey || press.metaKey) {
    if (press.key === 'Enter') return 'Mod+Enter';
    if (press.key.toLowerCase() === 'z') return press.shiftKey ? 'Mod+Shift+z' : 'Mod+z';
    // the other common redo key
    if (press.key.toLowerCase() === 'y' && !press.shiftKey) return 'Mod+y';
    return null;
  }
  if (/^\d$/.test(press.key)) return press.key;
  const digit = /^Digit(\d)$/.exec(press.code);
  if (digit) return press.shiftKey && SYMBOL_KEYS.includes(press.key) ? press.key : digit[1];
  if (press.shiftKey && (ARROWS.includes(press.key) || press.key === 'Tab')) {
    return `Shift+${press.key}`;
  }
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
  /** the key is being held down and this is one of its repeats */
  repeat?: boolean;
};

function isLive(binding: KeyBinding, context: KeyContext): boolean {
  if (binding.passive) return false;
  if (context.repeat && !binding.repeat) return false;
  // first of all: what is typed into a text box is text, also "?" and Escape
  // while the cheat sheet is open
  if (context.typing && !binding.typing) return false;
  if (context.dialog) return binding.dialog === true;
  if (binding.dialog) return false;
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

/**
 * An interface that can be edited has all its keys, or none while the page
 * holds them back (the skip form is open). A read-only one has only the keys
 * marked `readOnly`: looking around, never changing.
 */
function liveInterfaceKeys(schema: TaskSchema, context: InterfaceContext): KeyBinding[] {
  if (context.dialog || context.typing) return [];
  if (!context.readOnly && !interfaceKeysOn(context)) return [];
  return interfaceKeys(schema).filter(
    (b) => !b.passive && (!context.repeat || b.repeat) && (!context.readOnly || b.readOnly),
  );
}

/** The page action a key stands for right now, or null. */
export function pageAction(key: string, context: KeyContext): string | null {
  const live = livePageKeys(context);
  const hit =
    live.find((b) => b.keys.includes(key)) ?? live.find((b) => b.keys.includes(ANY_OTHER_KEY));
  return hit?.action ?? null;
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
 * Which interface the keys go to. A page with one interface has no choice to
 * make. With several (the qualification test) it is the one whose card holds
 * the focus or was clicked last, and none before that: a key must never
 * change an answer that the person is not looking at.
 */
export function activeInterface<T>(mounted: readonly T[], lastUsed: T | null): T | null {
  if (mounted.length === 1) return mounted[0];
  return lastUsed !== null && mounted.includes(lastUsed) ? lastUsed : null;
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

const KEY_WORDS: Record<string, string> = {
  'Mod+Enter': 'Ctrl + Enter',
  'Mod+z': 'Ctrl + Z',
  'Mod+Shift+z': 'Ctrl + Shift + Z',
  'Mod+y': 'Ctrl + Y',
  'Shift+Tab': 'Shift + Tab',
  ArrowLeft: '←',
  ArrowRight: '→',
  'Shift+ArrowLeft': 'Shift + ←',
  'Shift+ArrowRight': 'Shift + →',
  Escape: 'Esc',
  [ANY_OTHER_KEY]: 'any other key',
};

/** Keys the way the cheat sheet and the hints print them. */
export function showKeys(keys: readonly string[]): string {
  if (keys.length === ARROWS.length && keys.every((key) => ARROWS.includes(key))) return 'Arrows';
  if (keys.length === ARROWS.length && keys.every((key) => ARROWS.includes(key.slice(6)))) {
    return 'Shift + arrows';
  }
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
