import { redirect } from 'react-router';

import { getSession, sessionStorage } from './session.server';

/** Redirects and shows a one-time message on the next page. */
export async function redirectWithFlash(request: Request, to: string, message: string) {
  const session = await getSession(request);
  session.flash('flash', message);
  return redirect(to, { headers: { 'Set-Cookie': await sessionStorage.commitSession(session) } });
}

/** Reads (and clears) the pending message. Send the returned header with the response. */
export async function consumeFlash(request: Request) {
  const session = await getSession(request);
  const message = session.get('flash') ?? null;
  return {
    message,
    headers: message ? { 'Set-Cookie': await sessionStorage.commitSession(session) } : undefined,
  };
}
