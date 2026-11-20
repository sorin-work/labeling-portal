import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { packUnsaved, readUnsaved, saveDelay, type UnsavedCopy } from '~/domain/drafts';

export type DraftState = 'idle' | 'restored' | 'saving' | 'saved' | 'failed' | 'stopped';

type Options = {
  /** the resource route that stores the draft */
  url: string;
  answer: object | null;
  /** working time to store with the draft, on pages that count it */
  seconds?: number;
  /** the page started from a stored draft */
  restored: boolean;
  /**
   * This page's own submit, skip or release is on its way. No save may follow
   * it. Other form posts (the sign-out in the layout) do not count.
   */
  handingIn: boolean;
  /** called once after a reload with what the closed page could not save in time */
  onRecover: (unsaved: UnsavedCopy) => void;
};

async function post(url: string, body: FormData, keepalive: boolean): Promise<DraftState> {
  try {
    const response = await fetch(url, { method: 'POST', body, keepalive });
    // a redirect means the session ended and the sign-in page came back
    if (response.ok && !response.redirected) return 'saved';
    return response.status >= 500 ? 'failed' : 'stopped';
  } catch {
    // browsers refuse a keepalive request with a large body; try without
    return keepalive ? post(url, body, false) : 'failed';
  }
}

function setLocal(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // storage can be disabled; the server copy is still there
  }
}

// the pages that are saving drafts right now, so that sign-out can reach them
const savers = new Set<() => void>();

/**
 * For the sign-out button, before its request leaves: saves what the open
 * task has not saved yet, while the session is still there.
 */
export function beforeSignOut() {
  for (const saveNow of savers) saveNow();
}

/**
 * Saves the answer in progress to the server: shortly after the last change,
 * when the tab is hidden or closed, and when the page is left inside the app.
 * Working time alone is saved every half minute. It uses plain `fetch` and
 * not a fetcher, because a fetcher that fails (no network for a moment) puts
 * the error page in place of the task and the unsaved answer with it.
 *
 * A reload is faster than the save a closing page sends, so the closing page
 * also leaves its unsaved work in sessionStorage and the next one takes it
 * from there (`onRecover`).
 *
 * The caller must be mounted once per assignment (`key`), or the first save
 * for a new task would store the previous task's answer.
 */
export function useDraftSave(options: Options): DraftState {
  const { url, answer, seconds = 0, restored, handingIn } = options;
  const json = useMemo(() => (answer ? JSON.stringify(answer) : ''), [answer]);
  const [state, setState] = useState<DraftState>(restored ? 'restored' : 'idle');
  // what the page holds now, and what the server has
  const page = useRef({ json, seconds, handingIn, onRecover: options.onRecover });
  const server = useRef({ json, seconds });
  const unsaved = useRef<{
    changedAt: number | null;
    dirtySince: number | null;
    failedAt: number | null;
  }>({ changedAt: null, dirtySince: null, failedAt: null });
  const sending = useRef(false);
  const stopped = useRef(false);
  const localKey = `labeling-portal:unsaved:${url}`;

  useEffect(() => {
    page.current = { json, seconds, handingIn, onRecover: options.onRecover };
  });

  useEffect(() => {
    let local: UnsavedCopy | null = null;
    try {
      local = readUnsaved(window.sessionStorage.getItem(localKey));
    } catch {
      // storage can be disabled
    }
    if (!local) return;
    setLocal(localKey, null);
    page.current.onRecover(local);
    if (local.draft) setState('restored');
  }, [localKey]);

  const save = useCallback(
    async (leavingPage: boolean) => {
      if (sending.current || stopped.current) return;
      const next = { json: page.current.json, seconds: page.current.seconds };
      const changed = next.json !== server.current.json;
      if (!changed && next.seconds <= server.current.seconds) return;

      // an unchanged answer is not sent again, so a tab that was only looked
      // at cannot overwrite the draft of the tab that was worked in
      const body = new FormData();
      if (changed) body.set('draft', next.json);
      body.set('activeSeconds', String(next.seconds));
      sending.current = true;
      setState('saving');
      const outcome = await post(url, body, leavingPage);
      sending.current = false;

      if (outcome === 'saved') {
        server.current = next;
        const editedSince = page.current.json !== next.json;
        unsaved.current = {
          changedAt: editedSince ? unsaved.current.changedAt : null,
          dirtySince: editedSince ? unsaved.current.changedAt : null,
          failedAt: null,
        };
        if (!editedSince) setLocal(localKey, null);
      } else if (outcome === 'failed') {
        unsaved.current.failedAt = Date.now();
      } else {
        stopped.current = true;
        setLocal(localKey, null);
      }
      setState(outcome);
    },
    [url, localKey],
  );

  useEffect(() => {
    if (json === server.current.json) {
      unsaved.current.changedAt = null;
      unsaved.current.dirtySince = null;
      return;
    }
    const now = Date.now();
    unsaved.current.changedAt = now;
    unsaved.current.dirtySince ??= now;
  }, [json]);

  useEffect(() => {
    // while the hand-in is on its way a save would only race it; when it
    // comes back with an error this runs again and saving goes on
    if (handingIn || state === 'saving' || state === 'stopped') return;
    const wait = saveDelay(
      { ...unsaved.current, unsavedSeconds: seconds - server.current.seconds },
      Date.now(),
    );
    if (wait === null) return;
    const timer = window.setTimeout(() => void save(false), wait);
    return () => window.clearTimeout(timer);
  }, [json, seconds, handingIn, state, save]);

  useEffect(() => {
    const path = window.location.pathname;
    const keepLocal = () => setLocal(localKey, packUnsaved(page.current, server.current));

    // The tab is hidden or the page is closed or reloaded. The local copy is
    // what a reload reads; it is written even during a hand-in, in case that
    // request does not get through.
    const onHide = () => {
      if (stopped.current) return;
      keepLocal();
      if (!page.current.handingIn) void save(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    const saveNow = () => {
      if (!page.current.handingIn) void save(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    savers.add(saveNow);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      savers.delete(saveNow);
      if (stopped.current) return;
      const handedIn = page.current.handingIn && window.location.pathname !== path;
      if (handedIn) {
        // the claim is over, and so is its draft
        setLocal(localKey, null);
      } else {
        // Taken down on the same address while handing in: that request
        // failed and the error page replaces the task. Keep the answer here.
        if (page.current.handingIn) keepLocal();
        void save(true);
      }
    };
  }, [save, localKey]);

  return state;
}
