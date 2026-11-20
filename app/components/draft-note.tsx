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

/**
 * Says whether the answer in progress is safe on the server. Only trouble is
 * said aloud: a screen reader that announced every save would talk over the
 * work.
 */
export function DraftNote({ state }: { state: DraftState }) {
  const note = state === 'idle' ? null : NOTES[state];
  const trouble = state === 'failed' || state === 'stopped';
  return (
    <>
      <span role="status" className="sr-only">
        {trouble && note ? `${note.text}. ${note.title}` : ''}
      </span>
      {note && (
        <span
          className={cx('text-xs', trouble ? 'text-amber-700' : 'text-slate-500')}
          title={note.title}
          aria-hidden={trouble || undefined}
        >
          {note.text}
        </span>
      )}
    </>
  );
}
