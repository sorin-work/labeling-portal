import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  activeInterface,
  interfaceAction,
  isNativeKey,
  isTextEntry,
  keyName,
  pageAction,
  type FocusTarget,
  type InterfaceHit,
  type KeyContext,
  type Page,
} from '~/domain/hotkeys';
import type { TaskSchema } from '~/domain/task-schema';

/**
 * Several listeners share one page: the page itself, the cheat sheet and each
 * labeling interface. What they have to agree on lives here: which page keys
 * are in force and in which mode, whether the cheat sheet is open, and which
 * interface the keys go to. Which key means what is decided in
 * `domain/hotkeys.ts`; these hooks only listen and pass the answer on.
 */
const shared = {
  page: null as KeyContext['page'],
  dialogs: 0,
  /** one entry per mounted interface: its card's token, or its own */
  interfaces: [] as object[],
  lastUsed: null as object | null,
  watchers: new Set<() => void>(),
};

const cards = () => [...new Set(shared.interfaces)];
const activeCard = () => activeInterface(cards(), shared.lastUsed);
const watch = (onChange: () => void) => {
  shared.watchers.add(onChange);
  return () => {
    shared.watchers.delete(onChange);
  };
};
const changed = () => {
  for (const tell of shared.watchers) tell();
};
const claim = (token: object) => {
  if (shared.lastUsed === token) return;
  shared.lastUsed = token;
  changed();
};

/**
 * The card an interface sits in, when a page shows several (one question of
 * the qualification test). Everything inside the card counts as using that
 * interface, its heading and buttons included.
 */
const KeyScope = createContext<object | null>(null);
export const KeyScopeProvider = KeyScope.Provider;

/**
 * For the card around one of several interfaces. Spread `props` on the card,
 * wrap its content in `KeyScopeProvider` with `token`, and show `active`: the
 * keys only go to the card that holds the focus or was clicked last, and to
 * none before that.
 */
export function useKeyScope() {
  const [token] = useState(() => ({}));
  const active = useSyncExternalStore(
    watch,
    () => cards().length > 1 && activeCard() === token,
    () => false,
  );
  const mark = () => claim(token);
  return { token, active, props: { onPointerDownCapture: mark, onFocusCapture: mark } };
}

/** True while a page has several interfaces and the keys go to none of them yet. */
export function useKeysUnclaimed(): boolean {
  return useSyncExternalStore(
    watch,
    () => cards().length > 1 && activeCard() === null,
    () => false,
  );
}

/** What the key map needs to know about the element an event came from. */
export function focusTarget(target: EventTarget | null): FocusTarget | null {
  if (!(target instanceof HTMLElement)) return null;
  return {
    tag: target.tagName,
    type: target.getAttribute('type'),
    editable: target.isContentEditable,
  };
}

/** Calls `onKey` with the key-map name of each key press that is meant for the app. */
function useKeys(onKey: (key: string, context: KeyContext) => boolean | void, enabled = true) {
  const handler = useRef(onKey);
  useEffect(() => {
    handler.current = onKey;
  });

  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      // One press, one action. A handler that acted has called
      // preventDefault, and its state change (the cheat sheet closing, a mode
      // ending) is already in force when the next listener runs.
      if (event.defaultPrevented) return;
      const key = keyName(event);
      const target = focusTarget(event.target);
      if (key === null || isNativeKey(target, key)) return;
      const context = {
        page: shared.page,
        dialog: shared.dialogs > 0,
        typing: isTextEntry(target),
      };
      if (handler.current(key, context)) event.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled]);
}

/**
 * Says which page keys are in force and in which mode ('labeling' or
 * 'skipping' on the work page, 'viewing' or 'fixing' on the review page).
 * Pages without keys of their own do not call it.
 */
export function useHotkeyPage(page: Page | null, mode: string) {
  useEffect(() => {
    if (!page) return;
    shared.page = { name: page, mode };
    return () => {
      shared.page = null;
    };
  }, [page, mode]);
}

/** While `open`, only the keys of the cheat sheet work. */
export function useHotkeyDialog(open: boolean) {
  useEffect(() => {
    if (!open) return;
    shared.dialogs += 1;
    return () => {
      shared.dialogs -= 1;
    };
  }, [open]);
}

/**
 * Page-level shortcuts. `onAction` gets the action from the key map and the
 * key, and returns true when it handled it.
 */
export function usePageHotkeys(onAction: (action: string, key: string) => boolean | void) {
  useKeys((key, context) => {
    const action = pageAction(key, context);
    return action ? onAction(action, key) : false;
  });
}

/**
 * Shortcuts of one labeling interface. Spread the returned props on the
 * interface's root element. On a page with several interfaces only the one
 * that is in use gets the keys (see `useKeyScope`).
 */
export function useInterfaceHotkeys(
  schema: TaskSchema,
  readOnly: boolean | undefined,
  onAction: (hit: InterfaceHit) => boolean | void,
) {
  const [own] = useState(() => ({}));
  const self = useContext(KeyScope) ?? own;
  const enabled = !readOnly;

  useEffect(() => {
    if (!enabled) return;
    shared.interfaces.push(self);
    changed();
    return () => {
      shared.interfaces.splice(shared.interfaces.indexOf(self), 1);
      if (shared.lastUsed === self && !shared.interfaces.includes(self)) shared.lastUsed = null;
      changed();
    };
  }, [self, enabled]);

  useKeys((key, context) => {
    if (activeCard() !== self) return false;
    const hit = interfaceAction(schema, key, { ...context, readOnly: !enabled });
    return hit ? onAction(hit) : false;
  }, enabled);

  const mark = () => {
    if (enabled) claim(self);
  };
  return { onPointerDownCapture: mark, onFocusCapture: mark };
}
