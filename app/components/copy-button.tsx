import { useState } from 'react';

/** Copies a value to the clipboard and says so for a moment. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard access can be blocked; nothing else to do
        }
      }}
      className="rounded px-1.5 py-0.5 text-xs text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
