import { useEffect, useState } from 'react';
import { Form } from 'react-router';

import { EXTEND_WINDOW_MS } from '~/domain/time-limit';

import { Button } from './ui';

/**
 * Shown in the last two minutes of a claim, with a button to ask for more
 * time while there are extensions left.
 */
export function TimeWarning({
  expiresAt,
  extensionsLeft,
}: {
  expiresAt: string;
  extensionsLeft: number;
}) {
  const end = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => end - Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setLeft(end - Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [end]);

  if (left > EXTEND_WINDOW_MS || left <= 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
    >
      <span>Less than two minutes left. Submit soon or the task goes back to the queue.</span>
      {extensionsLeft > 0 ? (
        <Form method="post" className="flex items-center gap-2">
          <Button name="intent" value="extend" variant="secondary">
            I need more time
          </Button>
          <span className="text-xs">
            {extensionsLeft === 1
              ? 'Last time you can ask'
              : `You can ask ${extensionsLeft} more times`}
          </span>
        </Form>
      ) : (
        <span>No more extra time can be given on this task.</span>
      )}
    </div>
  );
}
