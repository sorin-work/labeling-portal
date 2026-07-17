import type { Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '~/lib/db.server';
import { hashPassword, MIN_PASSWORD_LENGTH } from '~/lib/password.server';
import { ROLES } from '~/lib/permissions';

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
    include: { user: { select: { id: true, name: true, email: true, createdAt: true } } },
  });
}

/** Adds someone to the organisation, creating their account when it does not exist yet. */
export async function addPerson(
  orgId: string,
  input: z.infer<typeof newPersonSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    include: { memberships: { where: { orgId } } },
  });
  if (existing?.memberships.length) {
    return { ok: false, error: 'That person is already in this organisation.' };
  }
  if (existing) {
    await prisma.membership.create({ data: { orgId, userId: existing.id, role: input.role } });
    return { ok: true };
  }
  await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      passwordHash: await hashPassword(input.password),
      memberships: { create: { orgId, role: input.role } },
    },
  });
  return { ok: true };
}

/** Admins cannot demote or remove themselves, so an org always keeps an admin. */
export async function changeRole(orgId: string, actorId: string, userId: string, role: Role) {
  if (actorId === userId) return { ok: false as const, error: 'You cannot change your own role.' };
  const result = await prisma.membership.updateMany({ where: { orgId, userId }, data: { role } });
  return result.count ? { ok: true as const } : { ok: false as const, error: 'Person not found.' };
}

/** Sets a new password for a member of the organisation (e.g. after they forgot it). */
export async function setPassword(orgId: string, userId: string, password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false as const,
      error: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  const member = await prisma.membership.findFirst({ where: { orgId, userId } });
  if (!member) return { ok: false as const, error: 'Person not found.' };
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(password) },
  });
  return { ok: true as const };
}

export async function removePerson(orgId: string, actorId: string, userId: string) {
  if (actorId === userId) return { ok: false as const, error: 'You cannot remove yourself.' };
  await prisma.$transaction([
    prisma.projectMember.deleteMany({ where: { userId, project: { orgId } } }),
    prisma.membership.deleteMany({ where: { orgId, userId } }),
  ]);
  return { ok: true as const };
}
