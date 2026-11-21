/** An email as the sign-in limits count it: trimmed and in lower case, as the README's unlock command does. */
export function signInKey(email: string): string {
  return email.trim().toLowerCase();
}
