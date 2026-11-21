import type { Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '~/lib/db.server';
import { hashPassword, MIN_PASSWORD_LENGTH } from '~/lib/password.server';
import { ROLES } from '~/lib/permissions';

import { logActivity } from './activity.server';

export const newPersonSchema = z.object({
  name: z.string().trim().min(2, 'Enter a name').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  role: z.enum(ROLES),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`),
});

export function listPeople(orgId: string) {
  return prisma.membership.findMany({
    where: { orgId },
    orderBy: [{ role: 'asc' }, { user: { name: 'asc' } }],
    include: {
      user: { select: { id: true, name: true, email: true, createdAt: true, totpEnabledAt: true } },
    },
  });
}

/**
 * Adds someone to the organisation, creating their account when it does not
 * exist yet. The entry in the audit trail names the person and the role,
 * nothing about the password.
 */
export async function addPerson(
  orgId: string,
  actorId: string,
  input: z.infer<typeof newPersonSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    include: { memberships: { where: { orgId } } },
  });
  if (existing?.memberships.length) {
    return { ok: false, error: 'That person is already in this organisation.' };
  }
  // hashed before the transaction, which should not wait for it
  const passwordHash = existing ? null : await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    const user = existing
      ? existing
      : await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash: passwordHash! },
        });
    await tx.membership.create({ data: { orgId, userId: user.id, role: input.role } });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.added',
      detail: { userId: user.id, userName: user.name, role: input.role, newAccount: !existing },
    });
  });
  return { ok: true };
}

/** Admins cannot demote or remove themselves, so an org always keeps an admin. */
export async function changeRole(orgId: string, actorId: string, userId: string, role: Role) {
  if (actorId === userId) return { ok: false as const, error: 'You cannot change your own role.' };
  return prisma.$transaction(async (tx) => {
    const member = await tx.membership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { user: { select: { name: true } } },
    });
    if (!member) return { ok: false as const, error: 'Person not found.' };
    if (member.role === role) return { ok: true as const };
    await tx.membership.update({ where: { id: member.id }, data: { role } });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.role',
      detail: { userId, userName: member.user.name, from: member.role, to: role },
    });
    return { ok: true as const };
  });
}

/**
 * Sets a new password for a member of the organisation (e.g. after they
 * forgot it, or after their account was taken over). It ends every session
 * they have, in every browser. The audit trail says who set whose password,
 * and nothing else.
 */
export async function setPassword(
  orgId: string,
  actorId: string,
  userId: string,
  password: string,
) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false as const,
      error: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  const member = await prisma.membership.findFirst({
    where: { orgId, userId },
    include: { user: { select: { name: true } } },
  });
  if (!member) return { ok: false as const, error: 'Person not found.' };
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.password',
      detail: { userId, userName: member.user.name },
    });
  });
  return { ok: true as const };
}

/**
 * Ends every session of a member: each browser they are signed in on goes to
 * the sign-in page on its next request. When the actor is the member, this is
 * "Sign out everywhere" on the account page and the caller drops the cookie
 * of the browser that asked too. API tokens are not sessions and are left
 * alone.
 */
export async function endSessions(orgId: string, actorId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const member = await tx.membership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { user: { select: { name: true } } },
    });
    if (!member) return { ok: false as const, error: 'Person not found.' };
    await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.sessions_ended',
      detail: { userId, userName: member.user.name, own: actorId === userId },
    });
    return { ok: true as const };
  });
}

/**
 * Removes someone from the organisation. Their sessions end (the version goes
 * up, so a cookie made before does not come back if they are added again)
 * and their API tokens for this organisation are revoked.
 */
export async function removePerson(orgId: string, actorId: string, userId: string) {
  if (actorId === userId) return { ok: false as const, error: 'You cannot remove yourself.' };
  return prisma.$transaction(async (tx) => {
    const member = await tx.membership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { user: { select: { name: true } } },
    });
    if (!member) return { ok: false as const, error: 'Person not found.' };
    await tx.projectMember.deleteMany({ where: { userId, project: { orgId } } });
    await tx.membership.delete({ where: { id: member.id } });
    await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    const revoked = await tx.apiToken.updateMany({
      where: { orgId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.removed',
      detail: {
        userId,
        userName: member.user.name,
        role: member.role,
        tokensRevoked: revoked.count,
      },
    });
    return { ok: true as const };
  });
}
