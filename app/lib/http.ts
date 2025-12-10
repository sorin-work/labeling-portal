export function notFound(message = 'Not found'): Response {
  return new Response(message, { status: 404, statusText: message });
}

export function forbidden(message = 'You do not have access to this page.'): Response {
  return new Response(message, { status: 403, statusText: message });
}

export function badRequest(message = 'Bad request'): Response {
  return new Response(message, { status: 400, statusText: message });
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
