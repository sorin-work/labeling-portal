import { createCookieSessionStorage, redirect } from 'react-router';

import { cookieSecure, sessionSecret } from './env.server';

/**
 * `v` is the user's `sessionVersion` when the cookie was made. When that
 * number goes up, every cookie made before stops counting. A cookie from
 * before versions existed has no `v` and is read as 0, so the upgrade signed
 * nobody out.
 */
type SessionData = { userId: string; orgId: string; v: number };
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
  session.set('v', data.v);
  return redirect(redirectTo, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

/**
 * A Set-Cookie value that keeps this browser signed in with a new session
 * version, for the tab that just ended every other session.
 */
export async function renewSessionCookie(request: Request, v: number): Promise<string> {
  const session = await getSession(request);
  session.set('v', v);
  return sessionStorage.commitSession(session);
}

/** The session version a cookie was made with; a cookie without one is 0. */
export function sessionVersionOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

export async function destroyUserSession(request: Request): Promise<Response> {
  const session = await getSession(request);
  return redirect('/login', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}
