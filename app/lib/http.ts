export function notFound(message = 'Not found'): Response {
  return new Response(message, { status: 404, statusText: message });
}

export function forbidden(message = 'You do not have access to this page.'): Response {
  return new Response(message, { status: 403, statusText: message });
}

export function badRequest(message = 'Bad request'): Response {
  return new Response(message, { status: 400, statusText: message });
}

/** For routes that are called with `fetch` and read by a script, like the draft autosave. */
export function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * Refuses a POST that another site made the browser send. React Router checks
 * the origin itself for page actions, but not for resource routes, so the
 * routes that are called with `fetch` ask here. Browsers send `Origin` with
 * every POST; `Referer` is the fallback. A request with neither does not come
 * from a page in a browser and is let through, as React Router does.
 */
export function requireSameOrigin(request: Request): void {
  const source = request.headers.get('Origin') ?? request.headers.get('Referer');
  if (source === null) return;
  let origin: string | null = null;
  try {
    origin = new URL(source).origin;
  } catch {
    // "null" (a sandboxed page) or not a URL at all
  }
  if (origin !== new URL(request.url).origin) throw jsonError('cross_origin', 403);
}

/** Collects zod-style issues into a field -> first message map for forms. */
export function fieldErrors(
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length ? String(issue.path[0]) : '_form';
    errors[key] ??= issue.message;
  }
  return errors;
}
