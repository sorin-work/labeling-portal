import { useEffect, useState } from 'react';

/** A small toast for one-time messages; fades out after a few seconds. */
export function Flash({ message }: { message: string | null }) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    setVisible(Boolean(message));
    if (!message) return;
    const timer = window.setTimeout(() => setVisible(false), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (!message || !visible) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-3 text-sm text-white shadow-lg"
    >
      {message}
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="text-slate-400 hover:text-white"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
