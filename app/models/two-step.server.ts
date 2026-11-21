import type { Role } from '@prisma/client';

import {
  hashRecoveryCode,
  looksLikeRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  verifyTotp,
} from '~/domain/totp';
import { prisma } from '~/lib/db.server';
import { openSecret, sealSecret } from '~/lib/secret-box.server';

import { logActivity } from './activity.server';

/**
 * Two-step sign-in: a six-digit code from an authenticator app after the
 * password, or one of ten recovery codes. The secret is kept encrypted
 * (`lib/secret-box.server.ts`), the recovery codes as hashes, and the time
 * step of the last code taken so that a code works once.
 */

/** The roles an organisation's rule asks the second step of. */
export const TWO_STEP_ROLES: readonly Role[] = ['ADMIN', 'PROJECT_MANAGER'];

export function twoStepRequiredFor(role: Role, orgRequires: boolean): boolean {
  return orgRequires && TWO_STEP_ROLES.includes(role);
}

/**
 * Starts the setup: a new secret, kept as pending until a code from it is
 * right. Starting again replaces the pending one. Returns the secret, to show
 * as text and as a QR code.
 */
export async function startTwoStepSetup(
  userId: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpEnabledAt: true },
  });
  if (user.totpEnabledAt) return { ok: false, error: 'Two-step sign-in is already on.' };
  const secret = newTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpPending: sealSecret(secret) } });
  return { ok: true, secret };
}

/** The secret being set up, for showing it again after a reload, or null. */
export async function pendingTwoStepSecret(userId: string): Promise<string | null> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpPending: true, totpEnabledAt: true },
  });
  if (user.totpEnabledAt || !user.totpPending) return null;
  return openSecret(user.totpPending);
}

/**
 * Turns two-step sign-in on once a code from the pending secret is right.
 * Every other session ends (the caller renews this tab's cookie with the
 * returned version), and ten recovery codes are made, returned this once.
 */
export async function confirmTwoStepSetup(
  orgId: string,
  userId: string,
  code: string,
  now = new Date(),
): Promise<
  { ok: true; recoveryCodes: string[]; sessionVersion: number } | { ok: false; error: string }
> {
  const sealed = (
    await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { totpPending: true } })
  ).totpPending;
  const secret = sealed ? openSecret(sealed) : null;
  if (!sealed || !secret) return { ok: false, error: 'Start the setup again.' };
  const checked = verifyTotp(secret, code, now, null);
  if (!checked.ok) {
    return {
      ok: false,
      error:
        checked.reason === 'format'
          ? 'Type the six digits the app shows.'
          : 'That code is not right. Check that the phone’s clock is set automatically.',
    };
  }
  const recoveryCodes = newRecoveryCodes();
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.user.updateManyAndReturn({
      // the same pending secret that was checked, and not on yet
      where: { id: userId, totpPending: sealed, totpEnabledAt: null },
      data: {
        totpSecret: sealed,
        totpPending: null,
        totpEnabledAt: now,
        totpLastStep: checked.step,
        sessionVersion: { increment: 1 },
      },
      select: { sessionVersion: true },
    });
    if (!row) return { ok: false as const, error: 'Start the setup again.' };
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({
      data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
    });
    await logActivity(tx, {
      orgId,
      actorId: userId,
      action: 'account.two_step',
      detail: { on: true },
    });
    return { ok: true as const, recoveryCodes, sessionVersion: row.sessionVersion };
  });
}

export type SecondStepResult =
  | { ok: true; method: 'code' | 'recovery'; left?: number }
  | { ok: false; reason: 'format' | 'wrong' | 'used' | 'off' | 'key' };

/**
 * Checks what someone typed at the second step: a six-digit code, taken at
 * most once (the stored step only goes up, in one conditional update, so two
 * requests with the same code cannot both pass), or a recovery code, which
 * is marked used in the same way.
 */
export async function checkSecondStep(
  userId: string,
  typed: string,
  now = new Date(),
): Promise<SecondStepResult> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true },
  });
  if (!user.totpEnabledAt || !user.totpSecret) return { ok: false, reason: 'off' };
  if (looksLikeRecoveryCode(typed)) {
    const used = await prisma.recoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(typed), usedAt: null },
      data: { usedAt: now },
    });
    if (used.count === 0) return { ok: false, reason: 'wrong' };
    const left = await prisma.recoveryCode.count({ where: { userId, usedAt: null } });
    return { ok: true, method: 'recovery', left };
  }
  const secret = openSecret(user.totpSecret);
  if (!secret) return { ok: false, reason: 'key' };
  const checked = verifyTotp(secret, typed, now, user.totpLastStep);
  if (!checked.ok) return checked;
  const taken = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ totpLastStep: null }, { totpLastStep: { lt: checked.step } }],
    },
    data: { totpLastStep: checked.step },
  });
  if (taken.count === 0) return { ok: false, reason: 'used' };
  return { ok: true, method: 'code' };
}

/** What the account page shows about the second step. */
export async function twoStepStatus(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { totpEnabledAt: true },
  });
  const left = user.totpEnabledAt
    ? await prisma.recoveryCode.count({ where: { userId, usedAt: null } })
    : 0;
  return { enabledAt: user.totpEnabledAt, recoveryCodesLeft: left };
}

/** Clears the second step of a user, in a transaction the caller gives. */
async function clearTwoStep(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  endSessions: boolean,
) {
  await tx.user.update({
    where: { id: userId },
    data: {
      totpSecret: null,
      totpPending: null,
      totpEnabledAt: null,
      totpLastStep: null,
      ...(endSessions ? { sessionVersion: { increment: 1 } } : {}),
    },
  });
  await tx.recoveryCode.deleteMany({ where: { userId } });
}

/**
 * Turns one's own second step off, with a current code or a recovery code.
 * Refused while the organisation's rule asks it of the person's role.
 */
export async function turnOffTwoStep(
  orgId: string,
  userId: string,
  role: Role,
  typed: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { twoStepRequired: true },
  });
  if (twoStepRequiredFor(role, org.twoStepRequired)) {
    return {
      ok: false,
      error: 'Your organisation asks admins and project managers to keep it on.',
    };
  }
  const checked = await checkSecondStep(userId, typed, now);
  if (!checked.ok) return { ok: false, error: 'That code is not right.' };
  await prisma.$transaction(async (tx) => {
    await clearTwoStep(tx, userId, false);
    await logActivity(tx, {
      orgId,
      actorId: userId,
      action: 'account.two_step',
      detail: { on: false },
    });
  });
  return { ok: true };
}

/**
 * For an admin, when someone lost their phone and their recovery codes: the
 * second step is cleared and every session of the person ends. They sign in
 * with the password and, if the rule asks it of them, set it up again.
 */
export async function resetTwoStep(orgId: string, actorId: string, userId: string) {
  if (actorId === userId) {
    return { ok: false as const, error: 'Turn your own off on your account page.' };
  }
  return prisma.$transaction(async (tx) => {
    const member = await tx.membership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      include: { user: { select: { name: true, totpEnabledAt: true, totpPending: true } } },
    });
    if (!member) return { ok: false as const, error: 'Person not found.' };
    if (!member.user.totpEnabledAt && !member.user.totpPending) {
      return { ok: false as const, error: 'They have no second step to reset.' };
    }
    await clearTwoStep(tx, userId, true);
    await logActivity(tx, {
      orgId,
      actorId,
      action: 'person.two_step_reset',
      detail: { userId, userName: member.user.name },
    });
    return { ok: true as const };
  });
}

/**
 * The organisation's rule. An admin can only turn it on with their own second
 * step on, so the rule does not send them to set it up the moment it is
 * saved. Those it asks it of and who have none are sent to the account page
 * until they set it up.
 */
export async function setTwoStepRule(orgId: string, actorId: string, required: boolean) {
  const actor = await prisma.user.findUniqueOrThrow({
    where: { id: actorId },
    select: { totpEnabledAt: true },
  });
  if (required && !actor.totpEnabledAt) {
    return {
      ok: false as const,
      error: 'Turn on your own two-step sign-in first, on your account page.',
    };
  }
  return prisma.$transaction(async (tx) => {
    const [org] = await tx.organization.updateManyAndReturn({
      where: { id: orgId, twoStepRequired: !required },
      data: { twoStepRequired: required },
    });
    if (!org) return { ok: true as const };
    await logActivity(tx, { orgId, actorId, action: 'org.two_step_rule', detail: { required } });
    return { ok: true as const };
  });
}
