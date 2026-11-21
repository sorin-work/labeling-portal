import type { Membership, Role, User } from '@prisma/client';
import { redirect } from 'react-router';

import { prisma } from './db.server';
import { verifyPassword } from './password.server';
import { RateLimiter } from './rate-limit.server';
import { getSession, sessionVersionOf } from './session.server';
import { hashToken, TOKEN_PREFIX } from './tokens.server';

export type CurrentUser = {
  user: Pick<User, 'id' | 'email' | 'name'>;
  membership: Pick<Membership, 'id' | 'orgId' | 'role'>;
  /** the organisation asks the second step of this role and it is not on yet */
  mustSetUpTwoStep?: boolean;
};

/** The pages someone the two-step rule applies to can still open before setting it up. */
const SETUP_PATHS = ['/account', '/logout'];

/** Checks an email/password pair and returns the user with their first membership. */
export async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
  });
  if (!user) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok || user.memberships.length === 0) return null;
  return { user, membership: user.memberships[0] };
}

/** Paths of the JSON API, where a session cookie never counts. */
export function isApiPath(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return pathname === '/api' || pathname.startsWith('/api/');
}

export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  // the API takes tokens only; a route there that asks for the session gets nobody
  if (isApiPath(request)) return null;
  const session = await getSession(request);
  const userId = session.get('userId');
  const orgId = session.get('orgId');
  if (!userId || !orgId) return null;
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: {
      user: {
        select: { id: true, email: true, name: true, sessionVersion: true, totpEnabledAt: true },
      },
      org: { select: { twoStepRequired: true } },
    },
  });
  if (!membership) return null;
  // every session made before the last "sign out everywhere" or password change
  if (membership.user.sessionVersion !== sessionVersionOf(session.get('v'))) return null;
  const { user: account, org, ...rest } = membership;
  const user = { id: account.id, email: account.email, name: account.name };
  const mustSetUpTwoStep =
    org.twoStepRequired &&
    (rest.role === 'ADMIN' || rest.role === 'PROJECT_MANAGER') &&
    account.totpEnabledAt === null;
  return {
    user,
    membership: { id: rest.id, orgId: rest.orgId, role: rest.role },
    ...(mustSetUpTwoStep ? { mustSetUpTwoStep } : {}),
  };
}

export async function requireUser(request: Request): Promise<CurrentUser> {
  // closed by default: an API route that forgot `apiRoute` answers 401, not a sign-in page
  if (isApiPath(request)) throw apiError(401, 'The API takes a token, not a session.');
  const current = await getCurrentUser(request);
  if (!current) {
    const url = new URL(request.url);
    const next = url.pathname + url.search;
    throw redirect(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
  }
  if (current.mustSetUpTwoStep && !SETUP_PATHS.includes(new URL(request.url).pathname)) {
    throw redirect('/account?twoStep=required');
  }
  return current;
}

/** Like requireUser, but answers 403 unless the member has one of the given roles. */
export async function requireRole(request: Request, roles: Role[]): Promise<CurrentUser> {
  const current = await requireUser(request);
  if (!roles.includes(current.membership.role)) {
    throw new Response('You do not have access to this page.', { status: 403 });
  }
  return current;
}

/** What a request to the JSON API needs: reading, or writing too. */
export type ApiAccess = 'read' | 'write';

export type ApiUser = CurrentUser & { token: { id: string; readOnly: boolean } };

/** An error of the JSON API: always JSON, never a redirect or a page. */
export function apiError(status: number, error: string, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

/** 120 requests a minute per token, in memory and per process like the sign-in limiter. */
export const apiLimiter = new RateLimiter(120, 60_000);

/** `lastUsedAt` is written at most this often, so a read is not a write every time. */
const LAST_USED_EVERY_MS = 60_000;

/**
 * Who a request to the JSON API is, from its `Authorization: Bearer` token.
 * The only place a token is read: pages never look at the header, and this
 * never looks at the session cookie, so the two ways in stay apart. It
 * answers JSON 401 for no token or one that is unknown, revoked or expired
 * or whose person has left the organisation, and 429 past the per-token
 * limit. It only says who it is; what the token may do (read-only) is
 * `apiRoute`'s to decide. The role is the membership's as it is now, read on
 * every request as for the pages, so the same `requireProject` and `can`
 * checks apply.
 */
export async function requireApiUser(request: Request, now = new Date()): Promise<ApiUser> {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !match[1].startsWith(TOKEN_PREFIX)) {
    throw apiError(401, 'An API token is needed: Authorization: Bearer lp_...', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(match[1]) } });
  if (!token || token.revokedAt !== null || (token.expiresAt !== null && token.expiresAt <= now)) {
    throw apiError(401, 'The token is unknown, revoked or expired.', {
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    });
  }
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId: token.orgId, userId: token.userId } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!membership)
    throw apiError(401, 'The token belongs to someone who has left the organisation.');
  const limit = apiLimiter.hit(token.id, now.getTime());
  if (!limit.allowed) {
    throw apiError(429, 'Too many requests with this token.', {
      'Retry-After': String(limit.retryAfterSeconds),
    });
  }
  await prisma.apiToken.updateMany({
    where: {
      id: token.id,
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_EVERY_MS) } },
      ],
    },
    data: { lastUsedAt: now },
  });
  const { user, ...rest } = membership;
  return {
    user,
    membership: { id: rest.id, orgId: rest.orgId, role: rest.role },
    token: { id: token.id, readOnly: token.readOnly },
  };
}
