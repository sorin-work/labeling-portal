import { useState } from 'react';

import { useHotkeys } from './labeling/use-hotkeys';

const SHORTCUTS: Array<[string, string]> = [
  ['1 - 9', 'Pick a label, entity type or box label'],
  ['a / b / t', 'Pairwise: A better, B better, tie'],
  ['Delete', 'Remove the selected box'],
  ['Ctrl + Enter', 'Submit and go to the next task'],
  ['?', 'Show or hide this list'],
];

/** "?" opens a small list of the keyboard shortcuts on the work page. */
export function KeyboardHelp() {
  const [open, setOpen] = useState(false);
  useHotkeys((key) => {
    if (key === '?') {
      setOpen((o) => !o);
      return true;
    }
    if (key === 'Escape' && open) {
      setOpen(false);
      return true;
    }
    return false;
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-slate-500 hover:text-slate-800"
        aria-expanded={open}
      >
        Shortcuts (?)
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="fixed bottom-4 left-4 z-40 w-80 rounded-lg bg-white p-4 text-sm shadow-xl ring-1 ring-slate-200"
        >
          <h2 className="mb-2 font-semibold">Keyboard shortcuts</h2>
          <dl className="space-y-1">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className="flex gap-3">
                <dt className="w-24 shrink-0 font-mono text-xs text-slate-600">{keys}</dt>
                <dd className="text-slate-700">{what}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}
