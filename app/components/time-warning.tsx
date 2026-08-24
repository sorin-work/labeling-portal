import { useEffect, useState } from 'react';
import { Form } from 'react-router';

import { Button } from './ui';

const WARN_MS = 2 * 60_000;

/** Shown in the last two minutes of a claim, with a button to ask for more time. */
export function TimeWarning({ expiresAt, canExtend }: { expiresAt: string; canExtend: boolean }) {
  const end = new Date(expiresAt).getTime();
  const [left, setLeft] = useState(() => end - Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setLeft(end - Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [end]);

  if (left > WARN_MS || left <= 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200"
    >
      <span>Less than two minutes left. Submit soon or the task goes back to the queue.</span>
      {canExtend && (
        <Form method="post">
          <Button name="intent" value="extend" variant="secondary">
            I need more time
          </Button>
        </Form>
      )}
    </div>
  );
}
