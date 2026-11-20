import { apiRoute } from '~/lib/api.server';
import { listProjects } from '~/models/projects.server';

/** GET /api/v1/projects: the projects the token's person can see, as on the projects page. */
export const loader = apiRoute('read', async ({ current }) => {
  const projects = await listProjects(current);
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      status: p.status,
      overlap: p.overlap,
      createdAt: p.createdAt.toISOString(),
    })),
  };
});
