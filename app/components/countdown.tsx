import { useEffect, useState } from 'react';

import { cx } from './ui';

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Time left on a claim. Turns amber in the last five minutes. */
export function Countdown({ expiresAt }: { expiresAt: string }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = end - now;
  return (
    <span
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
  );
}
