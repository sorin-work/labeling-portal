/**
 * Reads a number field that older forms do not send: the default when the
 * field is missing, and not-a-number when it was emptied, so that a blank
 * comes out as an error and never as 0.
 */
export function readOptionalNumber(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).trim();
  return text === '' ? Number.NaN : Number(text);
}
