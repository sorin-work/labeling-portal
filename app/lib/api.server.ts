import { apiError, requireApiUser, type ApiAccess, type ApiUser } from './auth.server';

type Args = { request: Request; params: Record<string, string | undefined> };

/**
 * Marks a resource route as part of the JSON API. Only routes made with this
 * take a token, and every one says whether it reads or writes:
 *
 *   - the method must be the one the access allows (GET or HEAD to read,
 *     POST to write), whatever the route does;
 *   - a read-only token is refused for `write`, here and nowhere else;
 *   - what the handler throws comes back as JSON with its status (the 404 of
 *     `requireProject` for another organisation's project, its 403 for a
 *     missing capability), and a redirect becomes 401, never a page.
 *
 * The handler gets the same `CurrentUser` shape the pages get, and uses the
 * same model functions and checks they use.
 */
export function apiRoute(
  access: ApiAccess,
  handler: (args: Args & { current: ApiUser }) => Promise<unknown>,
) {
  return async (args: Args): Promise<Response> => {
    const method = args.request.method.toUpperCase();
    const allowed = access === 'read' ? ['GET', 'HEAD'] : ['POST'];
    if (!allowed.includes(method)) {
      return apiError(405, `Use ${allowed[0]} here.`, { Allow: allowed.join(', ') });
    }
    try {
      const current = await requireApiUser(args.request);
      // the one place a read-only token is refused
      if (access === 'write' && current.token.readOnly) {
        return apiError(403, 'This token is read-only.');
      }
      const result = await handler({ ...args, current });
      if (result instanceof Response) return result;
      return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
    } catch (thrown) {
      if (!(thrown instanceof Response)) throw thrown;
      if (thrown.headers.get('Content-Type')?.includes('application/json')) return thrown;
      if (thrown.status >= 300 && thrown.status < 400) return apiError(401, 'Not signed in.');
      const text = (await thrown.text()) || thrown.statusText || 'Request failed';
      return apiError(thrown.status, text);
    }
  };
}
