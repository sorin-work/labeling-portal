/**
 * The wait before a sign-in is checked when the app cannot tell clients
 * apart (no `TRUST_PROXY`), given how many attempts this email has had in the
 * window, this one included. The first few are free; after that each one
 * waits twice as long as the one before, up to five seconds. Nobody is
 * refused, so the owner always gets in with the right password.
 */
export const FREE_ATTEMPTS = 3;
export const FIRST_DELAY_MS = 250;
export const MAX_DELAY_MS = 5_000;

export function signInDelayMs(attempts: number): number {
  if (attempts <= FREE_ATTEMPTS) return 0;
  return Math.min(MAX_DELAY_MS, FIRST_DELAY_MS * 2 ** (attempts - FREE_ATTEMPTS - 1));
}

/** An email as the sign-in limits count it: trimmed and in lower case, as the README's unlock command does. */
export function signInKey(email: string): string {
  return email.trim().toLowerCase();
}
