import { useEffect, useRef, useState } from 'react';

import { timeAnnouncement } from '~/domain/time-limit';

import { cx } from './ui';

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Time left on a claim. Turns amber in the last five minutes, and says the
 * time left aloud at a few moments (`timeAnnouncement`) so that nobody is
 * surprised by the warning.
 */
export function Countdown({ expiresAt }: { expiresAt: string }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [end]);

  const left = end - now;
  const [said, setSaid] = useState('');
  const before = useRef(left);
  useEffect(() => {
    const message = timeAnnouncement(before.current, left);
    before.current = left;
    if (message) setSaid(message);
  }, [left]);
  return (
    <>
      <span role="status" className="sr-only">
        {said}
      </span>
      <span
        role="timer"
        aria-label="Time left on this task"
        className={cx(
          'rounded-md px-2 py-1 font-mono text-sm tabular-nums',
          left <= 0
            ? 'bg-rose-100 text-rose-800'
            : left < 5 * 60_000
              ? 'bg-amber-100 text-amber-800'
              : 'bg-slate-100 text-slate-700',
        )}
        title="Time left before this task goes back to the queue"
        suppressHydrationWarning
      >
        {left <= 0 ? 'Time is up' : format(left)}
      </span>
    </>
  );
}
