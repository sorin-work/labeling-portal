import { prisma } from '~/lib/db.server';
import { hashToken, newToken, TOKEN_PREFIX } from '~/lib/tokens.server';

import { logActivity } from './activity.server';

/** The characters after `lp_` that the list shows. */
const SHOWN = 8;
export const MAX_TOKEN_NAME = 80;
export const TOKEN_LIFETIMES = [30, 90, 365] as const;

export type NewToken = { name: string; readOnly: boolean; expiresInDays: number | null };

/**
 * Makes a token for the signed-in person in their organisation. The token is
 * returned once, here, and never again: only its hash and its first
 * characters are stored. The audit trail gets the name and whether it can
 * write, not the token.
 */
export async function createApiToken(
  orgId: string,
  userId: string,
  input: NewToken,
  now = new Date(),
): Promise<{ token: string; id: string }> {
  const token = newToken();
  return prisma.$transaction(async (tx) => {
    const row = await tx.apiToken.create({
      data: {
        orgId,
        userId,
        name: input.name,
        readOnly: input.readOnly,
        tokenHash: hashToken(token),
        prefix: token.slice(0, TOKEN_PREFIX.length + SHOWN),
        expiresAt:
          input.expiresInDays === null
            ? null
            : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60_000),
        createdAt: now,
      },
    });
    await logActivity(tx, {
      orgId,
      actorId: userId,
      action: 'token.created',
      detail: {
        tokenId: row.id,
        name: row.name,
        prefix: row.prefix,
        readOnly: row.readOnly,
        expiresAt: row.expiresAt?.toISOString() ?? null,
      },
      createdAt: now,
    });
    return { token, id: row.id };
  });
}

/** A person's tokens in one organisation, newest first, without anything that could be used. */
export function listApiTokens(orgId: string, userId: string) {
  return prisma.apiToken.findMany({
    where: { orgId, userId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      readOnly: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
}

/**
 * The tokens of a person that still work: not revoked and not expired. A
 * password change or "sign out everywhere" leaves these alone, so the pages
 * that end sessions name them with a way to revoke them.
 */
export function listActiveApiTokens(orgId: string, userId: string, now = new Date()) {
  return prisma.apiToken.findMany({
    where: {
      orgId,
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, readOnly: true, lastUsedAt: true },
  });
}

/** Revokes one of the person's own tokens. A token that is already revoked stays as it was. */
export async function revokeApiToken(
  orgId: string,
  userId: string,
  tokenId: string,
  now = new Date(),
) {
  return revoke(orgId, userId, userId, tokenId, now);
}

/**
 * Revokes a token of someone else in the organisation, for an admin who is
 * ending that person's sessions after their account was taken over. The
 * audit entry names whose token it was.
 */
export async function revokeApiTokenOf(
  orgId: string,
  actorId: string,
  userId: string,
  tokenId: string,
  now = new Date(),
) {
  return revoke(orgId, actorId, userId, tokenId, now);
}

async function revoke(orgId: string, actorId: string, userId: string, tokenId: string, now: Date) {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.apiToken.updateManyAndReturn({
      where: { id: tokenId, orgId, userId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (!row) return { ok: false as const };
    const owner =
      actorId === userId
        ? null
        : await tx.user.findUnique({ where: { id: userId }, select: { name: true } });
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'token.revoked',
      detail: {
        tokenId: row.id,
        name: row.name,
        prefix: row.prefix,
        ...(owner ? { userId, userName: owner.name } : {}),
      },
      createdAt: now,
    });
    return { ok: true as const };
  });
}
