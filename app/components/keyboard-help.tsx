import { useState } from 'react';

import { helpSections, type Page } from '~/domain/hotkeys';
import type { TaskSchema } from '~/domain/task-schema';

import { useHotkeyDialog, usePageHotkeys } from './labeling/use-hotkeys';

/**
 * "?" opens the list of keyboard shortcuts for this page and this project's
 * labeling kind. The list is made from the key map, the same table the key
 * handlers read. While it is open no other shortcut works.
 */
export function KeyboardHelp({ page, schema }: { page: Page | null; schema: TaskSchema }) {
  const [open, setOpen] = useState(false);
  useHotkeyDialog(open);
  usePageHotkeys((action) => {
    if (action === 'help') setOpen(true);
    else if (action === 'closeHelp') setOpen(false);
    else return false;
    return true;
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
          className="fixed bottom-4 left-4 z-40 max-h-[80vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg bg-white p-4 text-sm shadow-xl ring-1 ring-slate-200"
        >
          <h2 className="mb-2 font-semibold">Keyboard shortcuts</h2>
          {helpSections(page, schema).map((section) => (
            <section key={section.title} className="mt-3 first:mt-0">
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                {section.title}
              </h3>
              <dl className="space-y-1">
                {section.rows.map((row) => (
                  <div key={row.label} className="flex gap-3">
                    <dt className="w-32 shrink-0 font-mono text-xs text-slate-600">{row.keys}</dt>
                    <dd className="text-slate-700">{row.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <p className="mt-3 text-xs text-slate-500">
            Keys do nothing while you type in a text box. Press ? or Esc to close this list.
          </p>
        </div>
      )}
    </>
  );
}
