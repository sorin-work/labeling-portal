import { apiRoute } from '~/lib/api.server';
import { projectProgress } from '~/models/progress.server';
import { projectSchema, requireProject } from '~/models/projects.server';

/** GET /api/v1/projects/:projectId: one project with its schema and the numbers of its overview. */
export const loader = apiRoute('read', async ({ current, params }) => {
  const project = await requireProject(current, params.projectId ?? '');
  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      kind: project.kind,
      status: project.status,
      overlap: project.overlap,
      schema: projectSchema(project),
      createdAt: project.createdAt.toISOString(),
    },
    progress: await projectProgress(project.id),
  };
});
