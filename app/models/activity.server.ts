import type { Prisma } from '@prisma/client';

import { prisma } from '~/lib/db.server';

export type ActivityInput = {
  projectId: string;
  actorId: string;
  action: string;
  detail?: Prisma.InputJsonValue;
};

/** Records something a manager did to a project, for the activity tab. */
export function logActivity(input: ActivityInput) {
  return prisma.activity.create({ data: input });
}

export function listActivity(projectId: string, take = 100) {
  return prisma.activity.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { actor: { select: { name: true } } },
  });
}
