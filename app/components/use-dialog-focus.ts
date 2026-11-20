import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * While `open`: remembers what had focus, and gives it back when `open` ends,
 * if that element is still on the page and focus was lost with what closed.
 * When the person has moved focus on themselves (a key that went to the
 * feedback box), it stays there. For anything that opens over or next to what
 * the person was doing: the list of shortcuts, the skip form, the armed
 * approval.
 */
export function useRestoreFocus(open: boolean) {
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const element = before.current;
      before.current = null;
      // after the dialog's own content has gone
      window.setTimeout(() => {
        const lost = !document.activeElement || document.activeElement === document.body;
        if (lost && element?.isConnected) element.focus();
      });
    };
  }, [open]);
}

/**
 * A modal dialog: focus moves into it when it opens, Tab and Shift+Tab stay
 * inside it, and focus goes back where it was when it closes.
 */
export function useDialogFocus(open: boolean, dialog: RefObject<HTMLElement | null>) {
  useRestoreFocus(open);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const inside = Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = inside[0] ?? element;
      const last = inside[inside.length - 1] ?? element;
      const at = document.activeElement;
      if (event.shiftKey && (at === first || at === element)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !element.contains(at))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dialog]);
}
