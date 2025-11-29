import type { Membership, Role, User } from '@prisma/client';
import { redirect } from 'react-router';

import { prisma } from './db.server';
import { verifyPassword } from './password.server';
import { getSession } from './session.server';

export type CurrentUser = {
  user: Pick<User, 'id' | 'email' | 'name'>;
  membership: Pick<Membership, 'id' | 'orgId' | 'role'>;
};

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

export async function getCurrentUser(request: Request): Promise<CurrentUser | null> {
  const session = await getSession(request);
  const userId = session.get('userId');
  const orgId = session.get('orgId');
  if (!userId || !orgId) return null;
  const membership = await prisma.membership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!membership) return null;
  const { user, ...rest } = membership;
  return { user, membership: { id: rest.id, orgId: rest.orgId, role: rest.role } };
}

export async function requireUser(request: Request): Promise<CurrentUser> {
  const current = await getCurrentUser(request);
  if (!current) {
    const url = new URL(request.url);
    const next = url.pathname + url.search;
    throw redirect(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`);
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
