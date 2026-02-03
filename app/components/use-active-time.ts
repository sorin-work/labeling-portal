import { useEffect, useRef, useState } from 'react';

const IDLE_AFTER_MS = 2 * 60_000;

/**
 * Counts the seconds someone actually spends on a task: the tab must be
 * visible and they must have touched the mouse or keyboard in the last two
 * minutes. The server still caps the value at the time since the claim.
 */
export function useActiveTime(): number {
  const [seconds, setSeconds] = useState(0);
  const lastInput = useRef(0);

  useEffect(() => {
    lastInput.current = Date.now();
    const touch = () => {
      lastInput.current = Date.now();
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'scroll'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });

    const timer = window.setInterval(() => {
      const visible = document.visibilityState === 'visible';
      const idle = Date.now() - lastInput.current > IDLE_AFTER_MS;
      if (visible && !idle) setSeconds((s) => s + 1);
    }, 1000);

    return () => {
      window.clearInterval(timer);
      for (const e of events) window.removeEventListener(e, touch);
    };
  }, []);

  return seconds;
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
