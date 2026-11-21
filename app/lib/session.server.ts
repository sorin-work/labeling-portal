import { createCookieSessionStorage, redirect } from 'react-router';

import { cookieSecure, sessionSecret } from './env.server';

/**
 * `v` is the user's `sessionVersion` when the cookie was made. When that
 * number goes up, every cookie made before stops counting. A cookie from
 * before versions existed has no `v` and is read as 0, so the upgrade signed
 * nobody out.
 */
type SessionData = {
  userId: string;
  orgId: string;
  v: number;
  /**
   * After a right password, for someone with two-step sign-in on: who is
   * signing in, until the second step is right. `getCurrentUser` reads only
   * `userId`, so a pending sign-in is no session.
   */
  pending: { userId: string; orgId: string; v: number; at: number };
};

/** How long the second step waits after the password. */
export const PENDING_MS = 10 * 60_000;
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
  data: { userId: string; orgId: string; v: number },
  redirectTo: string,
): Promise<Response> {
  const session = await getSession(request);
  session.set('userId', data.userId);
  session.set('orgId', data.orgId);
  session.set('v', data.v);
  session.unset('pending');
  return redirect(redirectTo, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

/**
 * After the password, for someone with a second step: a cookie that holds
 * only the pending sign-in, and the way to the second page. Anyone signed in
 * before in this browser is signed out by it.
 */
export async function startPendingSignIn(
  request: Request,
  data: { userId: string; orgId: string; v: number },
  next: string,
  now = Date.now(),
): Promise<Response> {
  const session = await getSession(request);
  session.unset('userId');
  session.unset('orgId');
  session.unset('v');
  session.set('pending', { ...data, at: now });
  const target =
    next === '/' ? '/login/two-step' : `/login/two-step?next=${encodeURIComponent(next)}`;
  return redirect(target, {
    headers: { 'Set-Cookie': await sessionStorage.commitSession(session) },
  });
}

/** The pending sign-in of this browser, if it is there and not too old. */
export async function pendingSignIn(request: Request, now = Date.now()) {
  const session = await getSession(request);
  const pending = session.get('pending');
  if (!pending || typeof pending.userId !== 'string' || now - pending.at > PENDING_MS) return null;
  return pending;
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
