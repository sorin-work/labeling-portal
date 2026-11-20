import { useCallback, useEffect, useRef, useState } from 'react';

const IDLE_AFTER_MS = 2 * 60_000;

/** When the person last touched the mouse or keyboard on this page, as a ref. */
export function useLastInput() {
  const lastInput = useRef(0);

  useEffect(() => {
    lastInput.current = Date.now();
    const touch = () => {
      lastInput.current = Date.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, []);

  return lastInput;
}

/**
 * Counts the seconds someone actually spends on a task: the tab must be
 * visible and they must have touched the mouse or keyboard in the last two
 * minutes. The server still caps the value at the time since the claim.
 * `startAt` is the time already saved with a draft, so the count goes on after
 * a reload. The second value raises the count to a later saved value.
 * Nothing is counted while `counting` is false, as on a page that is
 * read-only for now.
 */
export function useActiveTime(startAt = 0, counting = true): [number, (atLeast: number) => void] {
  const [seconds, setSeconds] = useState(startAt);
  const lastInput = useLastInput();

  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => {
      const visible = document.visibilityState === 'visible';
      const idle = Date.now() - lastInput.current > IDLE_AFTER_MS;
      if (visible && !idle) setSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [lastInput, counting]);

  const raise = useCallback((atLeast: number) => setSeconds((s) => Math.max(s, atLeast)), []);
  return [seconds, raise];
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}
