/**
 * Only allow redirects to paths on this site. Anything else (absolute URLs,
 * protocol-relative "//host" links, backslash tricks) falls back to the default.
 */
export function safeRedirect(target: unknown, fallback = '/'): string {
  if (typeof target !== 'string' || target.length === 0) return fallback;
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return fallback;
  return target;
}
