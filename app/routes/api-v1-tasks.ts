import { apiError } from '~/lib/auth.server';
import { apiRoute } from '~/lib/api.server';
import { prisma } from '~/lib/db.server';
import { requireTaskViewer } from '~/models/projects.server';

/**
 * GET /api/v1/projects/:projectId/tasks?externalId=: status, consensus and
 * agreement of the task with that external id. The same people as on the
 * task page may ask (managers and reviewers).
 */
export const loader = apiRoute('read', async ({ current, params, request }) => {
  const project = await requireTaskViewer(current, params.projectId ?? '');
  const externalId = new URL(request.url).searchParams.get('externalId');
  if (!externalId) return apiError(400, 'Say which task: ?externalId=');
  // ids are unique within a file, not within a project: every match is listed
  const tasks = await prisma.task.findMany({
    where: { projectId: project.id, externalId },
    orderBy: { position: 'asc' },
    select: {
      id: true,
      externalId: true,
      position: true,
      status: true,
      consensus: true,
      agreement: true,
      completedAt: true,
      batchId: true,
    },
  });
  if (tasks.length === 0) return apiError(404, 'No task has that external id in this project.');
  return {
    tasks: tasks.map((t) => ({ ...t, completedAt: t.completedAt?.toISOString() ?? null })),
  };
});
