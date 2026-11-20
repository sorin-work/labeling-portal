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
  /** true while the page hands the work in, so that no save follows the submit */
  paused: boolean;
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
  const { url, answer, seconds = 0, restored, paused } = options;
  const json = useMemo(() => (answer ? JSON.stringify(answer) : ''), [answer]);
  const [state, setState] = useState<DraftState>(restored ? 'restored' : 'idle');
  // what the page holds now, and what the server has
  const page = useRef({ json, seconds, paused, onRecover: options.onRecover });
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
    page.current = { json, seconds, paused, onRecover: options.onRecover };
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
    async (leaving: boolean) => {
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
      const outcome = await post(url, body, leaving);
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
    if (paused || state === 'saving' || state === 'stopped') return;
    const wait = saveDelay(
      { ...unsaved.current, unsavedSeconds: seconds - server.current.seconds },
      Date.now(),
    );
    if (wait === null) return;
    const timer = window.setTimeout(() => void save(false), wait);
    return () => window.clearTimeout(timer);
  }, [json, seconds, paused, state, save]);

  useEffect(() => {
    const flush = () => {
      if (stopped.current) return;
      if (page.current.paused) return setLocal(localKey, null);
      setLocal(localKey, packUnsaved(page.current, server.current));
      void save(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      // leaving for another page of the app keeps what is unsaved too
      flush();
    };
  }, [save, localKey]);

  return state;
}
