import { createCookieSessionStorage, redirect } from 'react-router';

import { cookieSecure, sessionSecret } from './env.server';

type SessionData = { userId: string; orgId: string };
type SessionFlash = { flash: string };

export const sessionStorage = createCookieSessionStorage<SessionData, SessionFlash>({
  cookie: {
    name: '__lp_session',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: cookieSecure(),
    secrets: [sessionSecret()],
    maxAge: 60 * 60 * 24 * 14,
  },
});

export function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get('Cookie'));
}

export async function createUserSession(
  request: Request,
  data: SessionData,
  redirectTo: string,
): Promise<Response> {
  const session = await getSession(request);
  session.set('userId', data.userId);
  session.set('orgId', data.orgId);
  return redirect(redirectTo, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

export async function destroyUserSession(request: Request): Promise<Response> {
  const session = await getSession(request);
  return redirect('/login', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}
