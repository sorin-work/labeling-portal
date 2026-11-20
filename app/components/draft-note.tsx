import { cx } from './ui';
import type { DraftState } from './use-draft-save';

const NOTES: Record<Exclude<DraftState, 'idle'>, { text: string; title: string }> = {
  restored: {
    text: 'Draft restored',
    title: 'This is the unfinished answer you left here earlier',
  },
  saving: { text: 'Saving draft…', title: 'Your answer so far is being saved' },
  saved: { text: 'Draft saved', title: 'Your answer so far is kept if you reload or come back' },
  failed: {
    text: 'Draft not saved yet',
    title: 'The last save did not go through. It is tried again shortly.',
  },
  stopped: {
    text: 'Draft not saved',
    title: 'Saving stopped: the task is no longer open for you, or you are signed out',
  },
};

/** Says whether the answer in progress is safe on the server. */
export function DraftNote({ state }: { state: DraftState }) {
  if (state === 'idle') return null;
  const note = NOTES[state];
  const trouble = state === 'failed' || state === 'stopped';
  return (
    <span
      className={cx('text-xs', trouble ? 'text-amber-700' : 'text-slate-500')}
      title={note.title}
    >
      {note.text}
    </span>
  );
}
