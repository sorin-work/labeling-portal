import type { Prisma, Project } from '@prisma/client';

import { validateAnswer, type Answer } from '~/domain/answers';
import { hasPassed, MAX_QUALIFICATION_ATTEMPTS, scoreQualification } from '~/domain/qualification';
import { prisma } from '~/lib/db.server';

import { projectSchema } from './projects.server';

export function qualificationTasks(projectId: string) {
  return prisma.task.findMany({
    where: { projectId, isQualification: true },
    orderBy: { position: 'asc' },
    select: { id: true, data: true, goldAnswer: true },
  });
}

export type QualificationStatus = {
  required: boolean;
  qualified: boolean;
  attempts: number;
  attemptsLeft: number;
  lastScore: number | null;
  passPercent: number;
  taskCount: number;
};

export async function qualificationStatus(
  project: Project,
  userId: string,
): Promise<QualificationStatus> {
  const [member, attempts, taskCount] = await Promise.all([
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: project.id, userId } },
    }),
    prisma.qualificationAttempt.findMany({
      where: { projectId: project.id, userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.task.count({ where: { projectId: project.id, isQualification: true } }),
  ]);
  return {
    required: project.qualificationRequired,
    qualified: !project.qualificationRequired || member?.qualifiedAt != null,
    attempts: attempts.length,
    attemptsLeft: Math.max(0, MAX_QUALIFICATION_ATTEMPTS - attempts.length),
    lastScore: attempts[0]?.scorePercent ?? null,
    passPercent: project.qualificationPassPercent,
    taskCount,
  };
}

export type QualificationOutcome =
  | { ok: true; scorePercent: number; passed: boolean }
  | { ok: false; error: string };

/** Grades a test attempt and marks the member qualified when they pass. */
export async function submitQualification(
  project: Project,
  userId: string,
  answers: Record<string, unknown>,
  now = new Date(),
): Promise<QualificationOutcome> {
  const status = await qualificationStatus(project, userId);
  if (status.qualified) return { ok: false, error: 'You are already qualified for this project.' };
  if (status.attemptsLeft === 0) return { ok: false, error: 'You have used all your attempts.' };

  const schema = projectSchema(project);
  const tasks = await qualificationTasks(project.id);
  if (tasks.length === 0)
    return { ok: false, error: 'This project has no qualification test yet.' };

  const items: Array<{ answer: Answer; gold: Answer }> = [];
  for (const [index, task] of tasks.entries()) {
    const checked = validateAnswer(schema, task.data, answers[task.id]);
    if (!checked.ok) return { ok: false, error: `Question ${index + 1}: ${checked.error}` };
    items.push({ answer: checked.answer, gold: task.goldAnswer as Answer });
  }

  const { scorePercent } = scoreQualification(schema, items);
  const passed = hasPassed(scorePercent, project.qualificationPassPercent);
  await prisma.$transaction([
    prisma.qualificationAttempt.create({
      data: {
        projectId: project.id,
        userId,
        scorePercent,
        passed,
        answers: answers as Prisma.InputJsonValue,
        createdAt: now,
      },
    }),
    ...(passed
      ? [
          prisma.projectMember.update({
            where: { projectId_userId: { projectId: project.id, userId } },
            data: { qualifiedAt: now },
          }),
        ]
      : []),
  ]);
  return { ok: true, scorePercent, passed };
}
