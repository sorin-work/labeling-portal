import type { Prisma, Project } from '@prisma/client';

import type { ProjectInput } from '~/domain/project-form';
import { KIND_TO_ENUM, parseTaskSchema, type TaskSchema } from '~/domain/task-schema';
import type { CurrentUser } from '~/lib/auth.server';
import { prisma } from '~/lib/db.server';
import { forbidden, notFound } from '~/lib/http';
import { can, type Capability } from '~/lib/permissions';

/** Admins and project managers see every project in the org; others only their own. */
function visibleProjectsWhere(current: CurrentUser): Prisma.ProjectWhereInput {
  const base: Prisma.ProjectWhereInput = { orgId: current.membership.orgId };
  if (can(current.membership.role, 'manageProjects')) return base;
  return {
    ...base,
    status: { in: ['ACTIVE', 'PAUSED'] },
    members: { some: { userId: current.user.id } },
  };
}

export async function listProjects(current: CurrentUser) {
  return prisma.project.findMany({
    where: visibleProjectsWhere(current),
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      description: true,
      kind: true,
      status: true,
      overlap: true,
      createdAt: true,
      _count: { select: { members: true } },
    },
  });
}

/**
 * Loads a project the current user may see, optionally requiring a capability.
 * Projects from other organisations are reported as missing, not forbidden.
 */
export async function requireProject(
  current: CurrentUser,
  projectId: string,
  capability?: Capability,
): Promise<Project> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ...visibleProjectsWhere(current) },
  });
  if (!project) throw notFound('Project not found');
  if (capability && !can(current.membership.role, capability)) throw forbidden();
  return project;
}

export function projectSchema(project: Pick<Project, 'schema'>): TaskSchema {
  const parsed = parseTaskSchema(project.schema);
  if (!parsed.ok) throw new Error(`Stored project schema is invalid: ${parsed.errors.join(', ')}`);
  return parsed.schema;
}

export async function createProject(orgId: string, input: ProjectInput) {
  return prisma.project.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      overlap: input.overlap,
      timeLimitMinutes: input.timeLimitMinutes,
      reviewRequired: input.reviewRequired,
      kind: KIND_TO_ENUM[input.schema.kind],
      schema: input.schema as Prisma.InputJsonValue,
    },
  });
}

export async function updateProject(projectId: string, input: ProjectInput) {
  return prisma.project.update({
    where: { id: projectId },
    data: {
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      overlap: input.overlap,
      timeLimitMinutes: input.timeLimitMinutes,
      reviewRequired: input.reviewRequired,
      kind: KIND_TO_ENUM[input.schema.kind],
      schema: input.schema as Prisma.InputJsonValue,
    },
  });
}
