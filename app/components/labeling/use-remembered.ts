import { useEffect, useState } from 'react';

/**
 * A choice (like the active entity type) that carries over to the next task in
 * the same browser tab. Starts with `fallback` so server and client render the
 * same thing, then switches to the remembered value after hydration.
 */
export function useRemembered(key: string, fallback: string, allowed: string[]) {
  const [value, setValue] = useState(fallback);
  const allowedKey = allowed.join('\u0000');

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored && allowedKey.split('\u0000').includes(stored)) setValue(stored);
    } catch {
      // storage can be disabled; just use the fallback
    }
  }, [key, allowedKey]);

  const update = (next: string) => {
    setValue(next);
    try {
      window.sessionStorage.setItem(key, next);
    } catch {
      // ignore
    }
  };
  return [value, update] as const;
}
