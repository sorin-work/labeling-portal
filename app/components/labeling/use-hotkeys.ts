import { useEffect, useRef, useState } from 'react';

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
  interfaces: [] as object[],
  lastUsed: null as object | null,
};

function describe(target: EventTarget | null): FocusTarget | null {
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
      const target = describe(event.target);
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
 * Shortcuts of one labeling interface. With several interfaces on a page the
 * keys go to the one that was used last; spread the returned props on the
 * interface's root element so it can tell when it is used.
 */
export function useInterfaceHotkeys(
  schema: TaskSchema,
  readOnly: boolean | undefined,
  onAction: (hit: InterfaceHit) => boolean | void,
) {
  const [self] = useState(() => ({}));
  const enabled = !readOnly;

  useEffect(() => {
    if (!enabled) return;
    shared.interfaces.push(self);
    return () => {
      shared.interfaces = shared.interfaces.filter((other) => other !== self);
      if (shared.lastUsed === self) shared.lastUsed = null;
    };
  }, [self, enabled]);

  useKeys((key, context) => {
    if (activeInterface(shared.interfaces, shared.lastUsed) !== self) return false;
    const hit = interfaceAction(schema, key, { ...context, readOnly: !enabled });
    return hit ? onAction(hit) : false;
  }, enabled);

  const use = () => {
    if (enabled) shared.lastUsed = self;
  };
  return { onPointerDownCapture: use, onFocusCapture: use };
}
