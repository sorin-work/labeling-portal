import type { KeyboardEvent } from 'react';

/**
 * For forms that decide something (a review, a skip): a plain Enter in one of
 * their fields does not hand them in. Browsers submit a form when Enter is
 * pressed in a field, through its first submit button, which on the review
 * page is Approve. A decision takes a click on its button or the key map's
 * path (`a` then Enter, Ctrl+Enter for the skip), which Ctrl or Cmd with
 * Enter still reaches. Textareas keep Enter for new lines.
 */
export function noImplicitSubmit(event: KeyboardEvent<HTMLFormElement>) {
  if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return;
  if (event.target instanceof HTMLInputElement) event.preventDefault();
}
