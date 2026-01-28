import type { Assignment, Prisma, Project } from '@prisma/client';

import { prisma } from '~/lib/db.server';

export type ClaimResult =
  | { ok: true; assignment: Assignment; resumed: boolean }
  | { ok: false; reason: 'inactive' | 'empty' };

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

/** The annotator's claim that is still within its time limit, if any. */
export function findActiveAssignment(projectId: string, userId: string, now = new Date()) {
  return prisma.assignment.findFirst({
    where: { projectId, userId, status: 'ACTIVE', expiresAt: { gt: now } },
    orderBy: { claimedAt: 'desc' },
  });
}

/**
 * Next task the annotator may work on: open, not already done or skipped by
 * them, and with fewer live claims/submissions than the project's overlap.
 */
async function nextCandidate(project: Project, userId: string, now: Date) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT t.id
    FROM "Task" t
    WHERE t."projectId" = ${project.id}
      AND t.status = 'OPEN'
      AND NOT EXISTS (
        SELECT 1 FROM "Assignment" mine
        WHERE mine."taskId" = t.id AND mine."userId" = ${userId}
          AND mine.status IN ('ACTIVE', 'SUBMITTED', 'SKIPPED')
      )
      AND (
        SELECT count(*) FROM "Assignment" a
        WHERE a."taskId" = t.id
          AND (a.status = 'SUBMITTED' OR (a.status = 'ACTIVE' AND a."expiresAt" > ${now}))
      ) < ${project.overlap}
    ORDER BY t.position
    LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * Marks claims that ran past their time limit as expired so the task goes back
 * to the queue. Runs lazily whenever someone asks for work.
 */
export async function releaseExpiredClaims(projectId?: string, now = new Date()): Promise<number> {
  const result = await prisma.assignment.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now }, ...(projectId ? { projectId } : {}) },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}

/** Gives the annotator their current claim, or claims the next available task. */
export async function claimNextTask(
  project: Project,
  userId: string,
  now = new Date(),
): Promise<ClaimResult> {
  await releaseExpiredClaims(project.id, now);
  const existing = await findActiveAssignment(project.id, userId, now);
  if (existing) return { ok: true, assignment: existing, resumed: true };
  if (project.status !== 'ACTIVE') return { ok: false, reason: 'inactive' };

  const taskId = await nextCandidate(project, userId, now);
  if (!taskId) return { ok: false, reason: 'empty' };

  const assignment = await prisma.assignment.create({
    data: {
      projectId: project.id,
      taskId,
      userId,
      claimedAt: now,
      expiresAt: addMinutes(now, project.timeLimitMinutes),
    },
  });
  return { ok: true, assignment, resumed: false };
}

export type AssignmentError = 'not_found' | 'not_active';

async function ownActive(assignmentId: string, userId: string) {
  const assignment = await prisma.assignment.findFirst({ where: { id: assignmentId, userId } });
  if (!assignment) return { error: 'not_found' as const };
  if (assignment.status !== 'ACTIVE') return { error: 'not_active' as const };
  return { assignment };
}

/** Time is reported by the browser; never credit more than has actually passed. */
export function clampActiveSeconds(reported: number, claimedAt: Date, now: Date): number {
  const elapsed = Math.max(0, Math.floor((now.getTime() - claimedAt.getTime()) / 1000));
  if (!Number.isFinite(reported) || reported < 0) return 0;
  return Math.min(Math.floor(reported), elapsed);
}

export async function submitAssignment(
  assignmentId: string,
  userId: string,
  input: { answer: Prisma.InputJsonValue; activeSeconds: number },
  now = new Date(),
): Promise<{ ok: true; assignment: Assignment } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  const assignment = await prisma.assignment.update({
    where: { id: assignmentId },
    data: {
      status: 'SUBMITTED',
      submittedAt: now,
      answer: input.answer,
      activeSeconds: clampActiveSeconds(input.activeSeconds, found.assignment.claimedAt, now),
    },
  });
  return { ok: true, assignment };
}

export async function skipAssignment(
  assignmentId: string,
  userId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  await prisma.assignment.update({
    where: { id: assignmentId },
    data: { status: 'SKIPPED', skipReason: reason },
  });
  return { ok: true };
}

/** Hands a claim back without an answer so someone else can take it. */
export async function releaseAssignment(
  assignmentId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; error: AssignmentError }> {
  const found = await ownActive(assignmentId, userId);
  if ('error' in found) return { ok: false, error: found.error! };
  await prisma.assignment.update({ where: { id: assignmentId }, data: { status: 'RELEASED' } });
  return { ok: true };
}
